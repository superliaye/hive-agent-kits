// Run executor — the Thread → Run → event-stream loop.
//
// Inputs (injected at module construction):
//   - threads   : the Threads store (read history, append messages)
//   - runs      : the Runs store    (record lifecycle)
//   - catalog   : agent lookup port (resolve agent_id → model + system prompt)
//   - gateway   : the completion port (the typed `completeStream()` call)
//   - secrets   : the auth-resolution port (provider → AuthInput)
//
// One verb: `startRun({ threadId, userMessage })` returns an
// AsyncIterable<RunEvent>. The lifecycle:
//
//   1. Resolve Thread → Agent → model + auth. If anything missing, emit
//      `run.failed` and stop.
//   2. Append the user message to the Thread (so the history written to
//      disk matches what we send to the model).
//   3. Insert a `running` Run row, emit `run.started`.
//   4. Drain `gateway.completeStream(...)` (the typed gateway Stream). Re-emit
//      each GatewayEvent wrapped in `model.event`. Accumulate the assistant
//      content from text + thinking + tool_use deltas. A typed
//      `GatewayFailure` (resolve miss or thrown adapter) arrives in-band as a
//      terminal failure item carrying its real GatewayErrorCode.
//   5. On `done`:
//      - finishReason=cancelled  → emit `run.cancelled`, mark Run row.
//      - finishReason=error      → emit `run.failed` with the classified
//                                  error (in-band `error` event OR typed
//                                  GatewayFailure).
//      - otherwise               → append assistant message to Thread,
//                                  emit `run.completed`, mark Run row.
//
// Concurrency: one in-flight Run per Thread. A second `startRun` on the
// same thread while one is active throws synchronously — caller bug, not
// a Run failure (no Run row is created for the rejected request).
//
// Tool execution: stops at `done(tool_use)` per Q1. The assistant message
// with tool_use blocks lands in the Thread; future Part 7 handles dispatch
// + re-running with tool_results.

import { TypedEmitter } from "../lib/typed-emitter.ts";
import type {
  CompletionInput,
  ContentBlock,
  FinishReason,
  GatewayErrorCode,
  GatewayEvent,
  Message,
} from "../model-gateway/types.ts";
import type { ThreadMessage } from "../threads/types.ts";
import { MODEL_FALLBACK } from "./defaults.ts";
import { drainCompletion } from "./effect/consume.ts";
import type {
  CatalogPort,
  CompletionPort,
  RunsStorePort,
  SecretsPort,
  ThreadsPort,
} from "./effect/ports.ts";
import type { Run, RunEvent, RunModuleEvents } from "./types.ts";

export type StartRunInput = {
  threadId: string;
  userMessage: ContentBlock[];
  /** Optional per-Run model override; falls back to Agent's harness config, then deployment default. */
  modelOverride?: string;
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

  /** Module event stream — audit subscribes here for lifecycle. */
  events: TypedEmitter<RunModuleEvents>;
};

export type CreateRunExecutorDeps = {
  threads: ThreadsPort;
  runs: RunsStorePort;
  catalog: CatalogPort;
  gateway: CompletionPort;
  secrets: SecretsPort;
  now?: () => number;
};

export function createRunExecutor(deps: CreateRunExecutorDeps): RunExecutor {
  const { threads, runs, catalog, gateway, secrets } = deps;
  const now = deps.now ?? Date.now;
  const events = new TypedEmitter<RunModuleEvents>();
  const inflight = new Map<string, { threadId: string; controller: AbortController }>();
  const threadsWithRun = new Set<string>();

  async function emitFailed(
    runId: string,
    code: NonNullable<Run["errorCode"]>,
    message: string,
  ): Promise<RunEvent> {
    // Audit-first: the emit (audit row) must precede the hive.db Run mutation,
    // and a persist failure must fail the originating op (ADR-0004 §Failure
    // semantics). TypedEmitter.emit is async, so a throwing audit listener only
    // surfaces via `await`.
    await events.emit("run.failed", { runId, code, message });
    runs.fail({ runId, code, message });
    return { type: "run.failed", runId, error: { code, message }, ts: now() };
  }

  // Pre-flight runs synchronously in `startRun` (not inside the generator
  // body) so caller-error checks fire BEFORE the iterable is constructed.
  // Without this split, an unconsumed iterable's generator body never
  // executes, and concurrent-Run / missing-Thread checks become race-prone.
  function startRun(input: StartRunInput): AsyncIterable<RunEvent> {
    const { threadId } = input;
    const thread = threads.get(threadId);
    if (!thread) {
      throw new Error(`runs/executor: thread not found: ${threadId}`);
    }
    if (threadsWithRun.has(threadId)) {
      throw new Error(`runs/executor: a Run is already in flight on thread ${threadId}`);
    }
    // Reserve the thread synchronously. Any path through `runIterator` —
    // including pre-iteration abandonment by the caller — must release it.
    threadsWithRun.add(threadId);
    return runIterator(input, thread.agentId);
  }

  async function* runIterator(input: StartRunInput, agentId: string): AsyncIterable<RunEvent> {
    const { threadId, userMessage, modelOverride } = input;
    // Outer try/finally guarantees the busy-thread reservation made
    // synchronously in `startRun` is released even if the iterator is
    // abandoned mid-iteration.
    try {
      // Agent lookup.
      const agent = catalog.get(agentId);
      if (!agent) {
        const run = runs.create({
          threadId,
          agentId,
          model: modelOverride ?? MODEL_FALLBACK,
        });
        yield await emitFailed(run.id, "agent_not_found", `unknown agent: ${agentId}`);
        return;
      }

      // Model resolution: per-Run override > harness config.model > deployment default.
      const configuredModel =
        typeof agent.config.model === "string" ? agent.config.model : undefined;
      const model = modelOverride ?? configuredModel ?? MODEL_FALLBACK;

      // Provider extraction (validated by the gateway's registry too; this
      // is just for the Secrets lookup).
      const slash = model.indexOf("/");
      if (slash < 1) {
        const run = runs.create({ threadId, agentId, model });
        yield await emitFailed(
          run.id,
          "invalid_request",
          `agent ${agentId} has malformed model: ${JSON.stringify(model)}`,
        );
        return;
      }
      const provider = model.slice(0, slash);

      // Auth lookup.
      const auth = await secrets.getAuth(provider);
      if (!auth) {
        const run = runs.create({ threadId, agentId, model });
        yield await emitFailed(
          run.id,
          "no_credentials",
          `no secret stored for provider "${provider}" — add it in Settings`,
        );
        return;
      }

      // Append the user message FIRST so on-disk history matches what we
      // send to the model.
      threads.append({ threadId, role: "user", content: userMessage });

      // Insert the Run row, emit run.started. Pre-generate the id so the audit
      // emit precedes runs.create (audit-first): the run.id is normally produced
      // BY the insert, so awaiting the emit afterward would commit the Run row
      // before its audit row — the silent gap ADR-0004 forbids. CreateRunInput.id
      // is optional; passing it keeps the store unchanged.
      const runId = crypto.randomUUID();
      await events.emit("run.started", { runId, threadId, agentId, model });
      const run = runs.create({ id: runId, threadId, agentId, model });
      const controller = new AbortController();
      inflight.set(run.id, { threadId, controller });
      yield { type: "run.started", runId: run.id, threadId, agentId, model, ts: now() };

      // Build CompletionInput. Re-read history (which now includes the
      // user message we just appended).
      const history: Message[] = threads.getCompletionMessages(threadId);
      const systemPrompt = agent.promptBody.trim().length > 0 ? agent.promptBody : undefined;
      const completionInput: CompletionInput = {
        model,
        messages: history,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        auth,
        signal: controller.signal,
      };

      // Stream + accumulate. The completion port hands back the typed gateway
      // Stream; a thrown adapter/resolve failure arrives in-band as a typed
      // `GatewayFailure` (kind: "failure") carrying its real GatewayErrorCode —
      // there is no out-of-band throw path to reconcile.
      const accumulator = new AssistantAccumulator();
      let latestError: { code: GatewayErrorCode; message: string } | null = null;
      let finishReason: FinishReason | null = null;

      try {
        for await (const item of drainCompletion(gateway.completeStream(completionInput))) {
          if (item.kind === "failure") {
            latestError = { code: item.failure.code, message: item.failure.message };
            finishReason = "error";
            continue;
          }
          const ev = item.event;
          accumulator.consume(ev);
          if (ev.type === "error") {
            latestError = { code: ev.code, message: ev.message };
          }
          if (ev.type === "done") {
            finishReason = ev.finishReason;
          }
          yield { type: "model.event", runId: run.id, event: ev };
        }
      } finally {
        inflight.delete(run.id);
      }

      // Decide how to finalize.
      if (finishReason === "cancelled") {
        await events.emit("run.cancelled", { runId: run.id });
        runs.cancel(run.id);
        yield { type: "run.cancelled", runId: run.id, ts: now() };
        return;
      }
      // Per ADR-0005 an `error` event is always followed by `done(finishReason:
      // "error")`, and a typed gateway failure sets `finishReason` above — so an
      // error always lands here with `finishReason === "error"` carrying the
      // real code. (A bare `error` with no `done` is contract-forbidden.)
      if (finishReason === "error") {
        const code = latestError?.code ?? "unknown";
        const message = latestError?.message ?? "gateway emitted no error message";
        yield await emitFailed(run.id, code, message);
        return;
      }
      if (!finishReason) {
        yield await emitFailed(run.id, "unknown", "gateway stream ended without a `done` event");
        return;
      }

      // Happy path: persist the assistant message + complete the Run.
      const assistantContent = accumulator.finalize();
      const finalMessage: ThreadMessage = threads.append({
        threadId,
        role: "assistant",
        content: assistantContent,
      });
      // Audit-first relative to the Run-lifecycle mutation (runs.complete). The
      // separate Threads write above is the Threads module's concern and must
      // precede the yield regardless (finalMessage is yielded).
      await events.emit("run.completed", { runId: run.id, finishReason });
      runs.complete({ runId: run.id, finishReason });
      yield { type: "run.completed", runId: run.id, finishReason, finalMessage, ts: now() };
    } finally {
      threadsWithRun.delete(threadId);
    }
  }

  return {
    events,
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
  };
}

// ─── Accumulator ────────────────────────────────────────────────────────────

/**
 * Builds the assistant ContentBlock[] from a GatewayEvent stream. Mirrors
 * Anthropic's content-block semantics (parallel blocks identified by
 * `blockIndex`, deltas append, `_end` finalizes).
 *
 * tool_use args: GatewayEvent emits delta chunks (`tool_use_delta`) and a
 * final parsed object (`tool_use_end.args`). We trust the final parsed
 * object — adapters reassemble it (see ADR-0005 §"tool_use_end carries
 * parsed args").
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
      // text_end / tool_use_delta / refusal_delta / server_tool / usage / done / error:
      // not material to assembly. text_end is a punctuation event; deltas are
      // already appended; usage/done/error are lifecycle.
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
