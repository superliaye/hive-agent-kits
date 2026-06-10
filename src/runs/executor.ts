// Run executor — the Thread → Run → event-stream loop.
//
// Inputs (injected at module construction):
//   - threads    : the Threads store (read history, append messages)
//   - runs       : the Runs store    (record lifecycle)
//   - catalog    : agent lookup port (resolve agent_id → model + system prompt)
//   - gateway    : the completion port (the typed `completeStream()` call)
//   - secrets    : the auth-resolution port (provider → AuthInput)
//   - prefs      : per-agent user model + effort defaults, read-only
//   - capConfig  : the tool-loop iteration cap (snapshot once per Run)
//   - permission : the pre-dispatch gate (default: allowlist + denylist)
//   - shell      : the run_shell I/O edge (default: node:child_process)
//
// One verb: `startRun({ threadId, userMessage })` returns an
// AsyncIterable<RunEvent>. The lifecycle:
//
//   1. Resolve Thread → Agent → model + effort + backend + auth. If anything
//      missing, emit `run.failed` and stop.
//   2. Append the user message to the Thread.
//   3. Insert a `running` Run row, emit `run.started`.
//   4. Branch on backend (seam 3): `native` → the tool-loop; non-native →
//      a typed `invalid_request` failure (F replaces those arms with a CLI
//      spawn).
//   5. The tool-loop (seam 1) runs model turns; a `tool_use` turn is gated +
//      dispatched, results fed back as a `tool_result` user message, and the
//      loop re-invokes the model. A no-tool turn finalizes the Run.
//
// Concurrency: one in-flight Run per Thread. A second `startRun` on the
// same thread while one is active throws synchronously — caller bug, not
// a Run failure (no Run row is created for the rejected request).

import { TypedEmitter } from "../lib/typed-emitter.ts";
import type {
  CompletionInput,
  ContentBlock,
  FinishReason,
  GatewayErrorCode,
  GatewayEvent,
  ThinkingEffort,
  ToolDef,
} from "../model-gateway/types.ts";
import type { ThreadMessage } from "../threads/types.ts";
import { MODEL_FALLBACK } from "./defaults.ts";
import { drainCompletion } from "./effect/consume.ts";
import type {
  AgentModelPrefsPort,
  CapConfigPort,
  CatalogPort,
  CompletionPort,
  PermissionPort,
  RunsStorePort,
  SecretsPort,
  ShellRunnerPort,
  ThreadsPort,
} from "./effect/ports.ts";
import { createDefaultPermission } from "./permission.ts";
import { resolve } from "./resolve.ts";
import {
  buildToolRegistry,
  type ToolContext,
  type ToolRegistry,
  toolsForBindings,
} from "./tools/registry.ts";
import { createDefaultShellRunner, resolveWorkingDir } from "./tools/run-shell.ts";
import type { PermissionEvents, Run, RunEvent, RunModuleEvents } from "./types.ts";

export type StartRunInput = {
  threadId: string;
  userMessage: ContentBlock[];
  /** Optional per-Run model override; falls back to Agent's harness config, then deployment default. */
  modelOverride?: string;
  /**
   * Optional per-Run thinking-effort override; falls back to the user's
   * per-agent effort default, then the Agent's harness `config.thinkingEffort`,
   * then the provider default (no `thinking` sent).
   */
  effortOverride?: ThinkingEffort;
};

export type RunExecutor = {
  /**
   * Start a new Run on a Thread. Yields `RunEvent`s. The Run row is
   * created before the first event is yielded, so even abandoned
   * iterators leave a recorded Run.
   */
  startRun(input: StartRunInput): AsyncIterable<RunEvent>;

  /** Get a Run by id. Forwards to the underlying store. */
  getRun(runId: string): Run | undefined;

  /** Cancel an in-flight Run. Aborts the underlying gateway stream. */
  cancelRun(runId: string): void;

  /** List Runs on a thread, oldest first. */
  listByThread(threadId: string): Run[];

  /**
   * Newest terminal (non-`running`) Run on a thread by `endedAt`, carrying its
   * status — or null when the thread has no terminal Run.
   */
  newestTerminalRun(
    threadId: string,
  ): { status: "completed" | "failed" | "cancelled"; endedAt: number } | null;

  /**
   * Whether a Run is currently in flight on the thread.
   */
  isThreadBusy(threadId: string): boolean;

  /** Module event stream — audit subscribes here for lifecycle + tool-use. */
  events: TypedEmitter<RunModuleEvents>;

  /**
   * Dedicated `permission` AuditSource stream (Q4). Audit attaches this to the
   * `permission` source, separate from `events` (the `run` source).
   */
  permissionEvents: TypedEmitter<PermissionEvents>;
};

export type CreateRunExecutorDeps = {
  threads: ThreadsPort;
  runs: RunsStorePort;
  catalog: CatalogPort;
  gateway: CompletionPort;
  secrets: SecretsPort;
  /**
   * User's per-agent model + effort defaults — the tier between per-Run
   * override and the Agent's harness config. Optional: when absent the executor
   * falls back to harness/fallback only.
   */
  prefs?: AgentModelPrefsPort;
  /**
   * Tool-loop iteration cap (snapshot once per Run). Optional: when absent the
   * loop runs unbounded (the cap=0 default).
   */
  capConfig?: CapConfigPort;
  /** Pre-dispatch permission gate. Default: allowlist + destructive denylist. */
  permission?: PermissionPort;
  /** run_shell I/O edge. Default: node:child_process. */
  shell?: ShellRunnerPort;
  now?: () => number;
};

export function createRunExecutor(deps: CreateRunExecutorDeps): RunExecutor {
  const { threads, runs, catalog, gateway, secrets } = deps;
  const prefs: AgentModelPrefsPort = deps.prefs ?? {
    getModel: () => undefined,
    getEffort: () => undefined,
  };
  // cap=0 default ⇒ unlimited (Q5). Snapshot once per Run inside runIterator.
  const capConfig: CapConfigPort = deps.capConfig ?? { maxIterations: () => 0 };
  const shell: ShellRunnerPort = deps.shell ?? createDefaultShellRunner();
  const permission: PermissionPort = deps.permission ?? createDefaultPermission(catalog);
  const registry: ToolRegistry = buildToolRegistry({ shell });
  const now = deps.now ?? Date.now;
  const events = new TypedEmitter<RunModuleEvents>();
  const permissionEvents = new TypedEmitter<PermissionEvents>();
  const inflight = new Map<string, { threadId: string; controller: AbortController }>();
  const threadsWithRun = new Set<string>();

  async function emitFailed(
    runId: string,
    threadId: string,
    agentId: string,
    code: NonNullable<Run["errorCode"]>,
    message: string,
  ): Promise<RunEvent> {
    // Audit-first: the emit (audit row) must precede the hive.db Run mutation,
    // and a persist failure must fail the originating op (ADR-0004 §Failure
    // semantics).
    await events.emit("run.failed", { runId, threadId, agentId, code, message });
    runs.fail({ runId, code, message });
    return { type: "run.failed", runId, error: { code, message }, ts: now() };
  }

  // Pre-flight runs synchronously in `startRun` (not inside the generator
  // body) so caller-error checks fire BEFORE the iterable is constructed.
  function startRun(input: StartRunInput): AsyncIterable<RunEvent> {
    const { threadId } = input;
    const thread = threads.get(threadId);
    if (!thread) {
      throw new Error(`runs/executor: thread not found: ${threadId}`);
    }
    if (threadsWithRun.has(threadId)) {
      throw new Error(`runs/executor: a Run is already in flight on thread ${threadId}`);
    }
    threadsWithRun.add(threadId);
    return runIterator(input, thread.agentId);
  }

  async function* runIterator(input: StartRunInput, agentId: string): AsyncIterable<RunEvent> {
    const { threadId, userMessage, modelOverride, effortOverride } = input;
    try {
      // Agent lookup.
      const agent = catalog.get(agentId);
      if (!agent) {
        const run = runs.create({
          threadId,
          agentId,
          model: modelOverride ?? prefs.getModel(agentId) ?? MODEL_FALLBACK,
        });
        yield await emitFailed(
          run.id,
          threadId,
          agentId,
          "agent_not_found",
          `unknown agent: ${agentId}`,
        );
        return;
      }

      // Seam 2 — resolve model + effort + backend.
      const resolved = resolve({
        configuredModel: typeof agent.config.model === "string" ? agent.config.model : undefined,
        configuredEffort: agent.config.thinkingEffort,
        userModelDefault: prefs.getModel(agentId),
        userEffortDefault: prefs.getEffort(agentId),
        ...(modelOverride !== undefined ? { modelOverride } : {}),
        ...(effortOverride !== undefined ? { effortOverride } : {}),
        backend: agent.backend,
      });
      const { model } = resolved;

      if ("failure" in resolved) {
        const run = runs.create({ threadId, agentId, model });
        yield await emitFailed(
          run.id,
          threadId,
          agentId,
          "invalid_request",
          `agent ${agentId} has malformed model: ${JSON.stringify(model)}`,
        );
        return;
      }
      const { provider, effort, backend } = resolved;

      // Auth lookup.
      const auth = await secrets.getAuth(provider);
      if (!auth) {
        const run = runs.create({ threadId, agentId, model });
        yield await emitFailed(
          run.id,
          threadId,
          agentId,
          "no_credentials",
          `no secret stored for provider "${provider}" — add it in Settings`,
        );
        return;
      }

      // Append the user message FIRST so on-disk history matches what we send.
      threads.append({ threadId, role: "user", content: userMessage });

      // Insert the Run row, emit run.started (audit-first — see emitFailed note).
      const runId = crypto.randomUUID();
      await events.emit("run.started", { runId, threadId, agentId, model });
      const run = runs.create({ id: runId, threadId, agentId, model });
      const controller = new AbortController();
      inflight.set(run.id, { threadId, controller });
      yield { type: "run.started", runId: run.id, threadId, agentId, model, ts: now() };

      const systemPrompt = agent.promptBody.trim().length > 0 ? agent.promptBody : undefined;
      // Tools sent for this Run: registry filtered by the Agent's bound tools.
      const boundTools: ToolDef[] | undefined = toolsForBindings(registry, agent.bindings.tools);

      // Seam 3 — backend dispatch. F replaces the non-native arms.
      switch (backend) {
        case "native":
          yield* runToolLoop({
            runId: run.id,
            threadId,
            agentId,
            model,
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            ...(effort !== undefined ? { effort } : {}),
            auth,
            signal: controller.signal,
            ...(boundTools !== undefined ? { tools: boundTools } : {}),
            maxIterations: capConfig.maxIterations(),
          });
          return;
        case "claude-code":
        case "codex":
          yield await emitFailed(
            run.id,
            threadId,
            agentId,
            "invalid_request",
            `backend not yet implemented: ${backend}`,
          );
          return;
      }
    } finally {
      threadsWithRun.delete(threadId);
      // Release the in-flight reservation once the whole Run (all turns) ends,
      // including abandonment mid-loop. The controller (and its signal) is
      // reused across turns, so it must NOT be cleared per-turn.
      for (const [id, entry] of inflight) {
        if (entry.threadId === threadId) inflight.delete(id);
      }
    }
  }

  // ─── Seam 1: the tool-loop ────────────────────────────────────────────────

  type LoopArgs = {
    runId: string;
    threadId: string;
    agentId: string;
    model: string;
    systemPrompt?: string;
    effort?: ThinkingEffort;
    auth: CompletionInput["auth"];
    signal: AbortSignal;
    tools?: ToolDef[];
    /** 0 = unlimited (no cap, no grace). >0 = finite cap + one grace turn. */
    maxIterations: number;
  };

  async function* runToolLoop(args: LoopArgs): AsyncIterable<RunEvent> {
    const { runId, threadId, agentId, model, maxIterations } = args;
    const finite = maxIterations > 0;
    let turns = 0;

    while (true) {
      turns += 1;
      // Strip tools on a grace turn (finite cap reached) so the model must
      // produce a final text answer (Hermes strip-tools-force-summary).
      const graceTurn = finite && turns > maxIterations;
      const turnTools = graceTurn ? undefined : args.tools;

      const completionInput: CompletionInput = {
        model,
        messages: threads.getCompletionMessages(threadId),
        ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
        ...(args.effort !== undefined ? { thinking: { effort: args.effort } } : {}),
        ...(turnTools !== undefined ? { tools: turnTools } : {}),
        auth: args.auth,
        signal: args.signal,
      };

      const outcome = yield* runTurn(runId, completionInput);

      if (outcome.kind === "cancelled") {
        await events.emit("run.cancelled", { runId, threadId, agentId });
        runs.cancel(runId);
        yield { type: "run.cancelled", runId, ts: now() };
        return;
      }
      if (outcome.kind === "error") {
        yield await emitFailed(runId, threadId, agentId, outcome.code, outcome.message);
        return;
      }

      // Persist the assistant message this turn produced.
      const assistantMessage: ThreadMessage = threads.append({
        threadId,
        role: "assistant",
        content: outcome.assistant,
      });

      // No tools wanted, or this was the grace turn → finalize.
      if (outcome.kind === "text" || graceTurn) {
        await events.emit("run.completed", {
          runId,
          threadId,
          agentId,
          finishReason: outcome.finishReason,
        });
        runs.complete({ runId, finishReason: outcome.finishReason });
        yield {
          type: "run.completed",
          runId,
          finishReason: outcome.finishReason,
          finalMessage: assistantMessage,
          ts: now(),
        };
        return;
      }

      // outcome.kind === "tools" and not a grace turn: gate + dispatch each
      // call, then feed the tool_results back as a single user message.
      const resultBlocks: ContentBlock[] = [];
      for (const call of outcome.calls) {
        const result = await dispatchToolCall(runId, agentId, call);
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      threads.append({ threadId, role: "user", content: resultBlocks });
      // Loop: re-invoke the model with the tool_results now in history.
    }
  }

  // A single model turn: stream + accumulate, classify the outcome. Yields each
  // GatewayEvent wrapped in `model.event`; returns the typed turn outcome.
  type TurnOutcome =
    | { kind: "text"; assistant: ContentBlock[]; finishReason: FinishReason }
    | {
        kind: "tools";
        assistant: ContentBlock[];
        calls: Array<{ id: string; name: string; input: unknown }>;
        finishReason: FinishReason;
      }
    | { kind: "cancelled" }
    | { kind: "error"; code: GatewayErrorCode | "unknown"; message: string };

  async function* runTurn(
    runId: string,
    completionInput: CompletionInput,
  ): AsyncGenerator<RunEvent, TurnOutcome, void> {
    const accumulator = new AssistantAccumulator();
    let latestError: { code: GatewayErrorCode; message: string } | null = null;
    let finishReason: FinishReason | null = null;

    for await (const item of drainCompletion(gateway.completeStream(completionInput))) {
      if (item.kind === "failure") {
        latestError = { code: item.failure.code, message: item.failure.message };
        finishReason = "error";
        continue;
      }
      const ev = item.event;
      accumulator.consume(ev);
      if (ev.type === "error") latestError = { code: ev.code, message: ev.message };
      if (ev.type === "done") finishReason = ev.finishReason;
      yield { type: "model.event", runId, event: ev };
    }

    if (finishReason === "cancelled") return { kind: "cancelled" };
    if (finishReason === "error") {
      return {
        kind: "error",
        code: latestError?.code ?? "unknown",
        message: latestError?.message ?? "gateway emitted no error message",
      };
    }
    if (!finishReason) {
      return {
        kind: "error",
        code: "unknown",
        message: "gateway stream ended without a `done` event",
      };
    }

    const assistant = accumulator.finalize();
    const calls = assistant
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    if (calls.length > 0) {
      return { kind: "tools", assistant, calls, finishReason };
    }
    return { kind: "text", assistant, finishReason };
  }

  // Gate (permission, dedicated audit source) → dispatch (tool handler, run
  // audit source) a single tool_use call. Audit-first throughout: every emit is
  // awaited BEFORE its side effect.
  async function dispatchToolCall(
    runId: string,
    agentId: string,
    call: { id: string; name: string; input: unknown },
  ): Promise<{ content: string; isError: boolean }> {
    const command = commandOf(call.name, call.input);

    // Permission gate (emit on the dedicated permission source, audit-first).
    await permissionEvents.emit("permission.requested", {
      runId,
      agentId,
      tool: call.name,
      ...(command !== undefined ? { command } : {}),
    });
    const decision = await permission.decide({
      agentId,
      runId,
      tool: call.name,
      ...(command !== undefined ? { command } : {}),
      ...(argsOf(call.input) !== undefined ? { args: argsOf(call.input) } : {}),
    });
    await permissionEvents.emit("permission.decided", {
      runId,
      agentId,
      tool: call.name,
      ...(command !== undefined ? { command } : {}),
      outcome: decision.outcome,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (decision.outcome === "deny") {
      return {
        content: `Permission denied${decision.reason ? `: ${decision.reason}` : ""}.`,
        isError: true,
      };
    }

    const handler = registry.get(call.name);
    if (!handler) {
      return { content: `unknown tool: ${call.name}`, isError: true };
    }

    // Audit-first: emit the requested event (with a REDACTED arg summary —
    // never raw args, never stdout, Q6) BEFORE running the side effect.
    await events.emit("run.tool_use.requested", {
      runId,
      agentId,
      tool: call.name,
      toolUseId: call.id,
      ...(command !== undefined ? { command } : {}),
      ...(argSummaryOf(call.input) !== undefined ? { argSummary: argSummaryOf(call.input) } : {}),
    });
    const ctx: ToolContext = { agentId, runId, cwd: resolveWorkingDir(agentId) };
    const result = await handler.run(call.input, ctx);
    await events.emit("run.tool_use.executed", {
      runId,
      agentId,
      tool: call.name,
      toolUseId: call.id,
      isError: result.isError,
    });
    return result;
  }

  return {
    events,
    permissionEvents,
    startRun,
    getRun(runId) {
      return runs.get(runId);
    },
    cancelRun(runId) {
      const entry = inflight.get(runId);
      if (!entry) return;
      entry.controller.abort();
    },
    listByThread(threadId) {
      return runs.listByThread(threadId);
    },
    newestTerminalRun(threadId) {
      let newest: { status: "completed" | "failed" | "cancelled"; endedAt: number } | null = null;
      for (const r of runs.listByThread(threadId)) {
        if (r.status === "running" || r.endedAt === undefined) continue;
        if (newest === null || r.endedAt > newest.endedAt) {
          newest = { status: r.status, endedAt: r.endedAt };
        }
      }
      return newest;
    },
    isThreadBusy(threadId) {
      return threadsWithRun.has(threadId);
    },
  };
}

// run_shell carries a `command` ref + `args`. Pull them out for the gate +
// audit summary; other tools have no command (undefined).
function commandOf(tool: string, input: unknown): string | undefined {
  if (tool !== "run_shell") return undefined;
  if (input && typeof input === "object") {
    const c = (input as Record<string, unknown>).command;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function argsOf(input: unknown): string[] | undefined {
  if (input && typeof input === "object") {
    const a = (input as Record<string, unknown>).args;
    if (Array.isArray(a) && a.every((x) => typeof x === "string")) return a as string[];
  }
  return undefined;
}

// Redacted arg summary for audit — count only, never the values (ADR-0004:141).
function argSummaryOf(input: unknown): { count: number } | undefined {
  const args = argsOf(input);
  return args !== undefined ? { count: args.length } : undefined;
}

// ─── Accumulator ────────────────────────────────────────────────────────────

/**
 * Builds the assistant ContentBlock[] from a GatewayEvent stream. Mirrors
 * Anthropic's content-block semantics (parallel blocks identified by
 * `blockIndex`, deltas append, `_end` finalizes).
 */
class AssistantAccumulator {
  private readonly text = new Map<number, string>();
  private readonly thinking = new Map<
    number,
    { content: string; providerMetadata?: Record<string, unknown> }
  >();
  private readonly tools = new Map<number, { id: string; name: string; args: unknown }>();
  private readonly order: Array<
    | { kind: "text"; idx: number }
    | { kind: "thinking"; idx: number }
    | { kind: "tool"; idx: number }
  > = [];

  consume(ev: GatewayEvent): void {
    switch (ev.type) {
      case "text_start":
        this.text.set(ev.blockIndex, "");
        this.order.push({ kind: "text", idx: ev.blockIndex });
        break;
      case "text_delta":
        this.text.set(ev.blockIndex, (this.text.get(ev.blockIndex) ?? "") + ev.delta);
        break;
      case "thinking_start":
        this.thinking.set(ev.blockIndex, { content: "" });
        this.order.push({ kind: "thinking", idx: ev.blockIndex });
        break;
      case "thinking_delta": {
        const cur = this.thinking.get(ev.blockIndex) ?? { content: "" };
        cur.content += ev.delta;
        this.thinking.set(ev.blockIndex, cur);
        break;
      }
      case "thinking_end": {
        const cur = this.thinking.get(ev.blockIndex) ?? { content: "" };
        if (ev.providerMetadata) cur.providerMetadata = ev.providerMetadata;
        this.thinking.set(ev.blockIndex, cur);
        break;
      }
      case "tool_use_start":
        this.tools.set(ev.blockIndex, { id: ev.id, name: ev.name, args: {} });
        this.order.push({ kind: "tool", idx: ev.blockIndex });
        break;
      case "tool_use_end": {
        const cur = this.tools.get(ev.blockIndex);
        if (cur) {
          cur.args = ev.args;
          this.tools.set(ev.blockIndex, cur);
        }
        break;
      }
      default:
        break;
    }
  }

  finalize(): ContentBlock[] {
    const out: ContentBlock[] = [];
    for (const entry of this.order) {
      if (entry.kind === "text") {
        const text = this.text.get(entry.idx) ?? "";
        if (text.length > 0) out.push({ type: "text", text });
      } else if (entry.kind === "thinking") {
        const t = this.thinking.get(entry.idx);
        if (t && t.content.length > 0) {
          const sig =
            t.providerMetadata && typeof t.providerMetadata.signature === "string"
              ? (t.providerMetadata.signature as string)
              : undefined;
          out.push({
            type: "thinking",
            thinking: t.content,
            ...(sig ? { signature: sig } : {}),
            ...(t.providerMetadata ? { providerMetadata: t.providerMetadata } : {}),
          });
        }
      } else {
        const tool = this.tools.get(entry.idx);
        if (tool) {
          out.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.args });
        }
      }
    }
    return out;
  }
}
