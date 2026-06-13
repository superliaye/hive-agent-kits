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

import { mkdirSync } from "node:fs";
import { AgentBackend } from "../lib/capability-types.ts";
import { log } from "../lib/log.ts";
import { runtime as runtimePaths } from "../lib/paths.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import {
  type CompletionInput,
  type ContentBlock,
  type FinishReason,
  type GatewayErrorCode,
  type GatewayEvent,
  type ThinkingEffort,
  type ToolDef,
} from "../model-gateway/types.ts";
import type { ThreadMessage } from "../threads/types.ts";
import { MODEL_FALLBACK } from "./defaults.ts";
import { drainCompletion } from "./effect/consume.ts";
import type {
  AgentModelPrefsPort,
  CapConfigPort,
  CatalogPort,
  CliSpawnerPort,
  CompletionPort,
  FsCopyPort,
  FsRunnerPort,
  PermissionPort,
  RunnableCatalogPort,
  RunsStorePort,
  SecretsPort,
  ShellRunnerPort,
  SkillProjectionPort,
  SkillResolverPort,
  ThreadsPort,
} from "./effect/ports.ts";
import { createDefaultPermission } from "./permission.ts";
import { resolve } from "./resolve.ts";
import { type EffortDefault, isSymbolicEffort, isThinkingEffort } from "./symbolic.ts";
import { buildCliInvocation, type CliInvocationMode } from "./tools/cli-invocation.ts";
import { createDefaultFsCopy, projectSkillsForCli } from "./tools/cli-skill-projection.ts";
import { createDefaultCliSpawner } from "./tools/cli-spawn.ts";
import { parseCliStream } from "./tools/cli-stream.ts";
import { createDefaultFsRunner } from "./tools/file-tools.ts";
import { LOAD_SKILL_TOOL_NAME } from "./tools/names.ts";
import {
  buildToolRegistry,
  type ToolContext,
  type ToolRegistry,
  toolsForBindings,
} from "./tools/registry.ts";
import { createDefaultShellRunner, resolveWorkingDir } from "./tools/run-shell.ts";
import type { BackendEvents, PermissionEvents, Run, RunEvent, RunModuleEvents } from "./types.ts";

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

  /**
   * Dedicated `backend` AuditSource stream. Audit attaches this to the
   * `backend` source — the CLI-spawn audit, separate from `events`.
   */
  backendEvents: TypedEmitter<BackendEvents>;
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
   * Runnable model catalog (credentialed ∩ routable, newest-first) — the data
   * the symbolic-default resolver consumes. Optional: when absent a symbolic
   * "latest"/"highest" default resolves against an empty catalog (so a symbolic
   * model surfaces a typed model_not_found; concrete defaults are unaffected).
   */
  runnableCatalog?: RunnableCatalogPort;
  /**
   * Tool-loop iteration cap (snapshot once per Run). Optional: when absent the
   * loop runs unbounded (the cap=0 default).
   */
  capConfig?: CapConfigPort;
  /** Pre-dispatch permission gate. Default: allowlist + destructive denylist. */
  permission?: PermissionPort;
  /** run_shell I/O edge. Default: node:child_process. */
  shell?: ShellRunnerPort;
  /**
   * CLI streaming-spawn I/O edge — the seam the non-native (CLI-backed) dispatch
   * arm spawns through. Default: Bun.spawn. Optional and not yet consumed here;
   * `cli-dispatch-arm` (C2b) reads it.
   */
  cliSpawner?: CliSpawnerPort;
  /** File-tools I/O edge (read/write/edit). Default: node:fs/promises. */
  fs?: FsRunnerPort;
  /**
   * Skill resolver for `load_skill` + the Run-start listing. Optional: when
   * absent no skill resolves, so `load_skill` always returns `isError` and no
   * listing is injected (the executor stays runnable without capabilities).
   */
  skillResolver?: SkillResolverPort;
  /**
   * Skill projection for the CLI (claude-code) path: resolves bound skills to
   * `{ name, path, origin }` so their dirs can be copied into a `--add-dir`
   * location (C3). Optional: when absent no projection runs — the CLI gets no
   * `--add-dir` and the executor stays runnable without capabilities (same
   * discipline as the no-op skillResolver).
   */
  skillProjection?: SkillProjectionPort;
  /** FS copy edge for CLI skill projection. Default: node:fs/promises cp/rm. */
  fsCopy?: FsCopyPort;
  now?: () => number;
};

export function createRunExecutor(deps: CreateRunExecutorDeps): RunExecutor {
  const { threads, runs, catalog, gateway, secrets } = deps;
  const prefs: AgentModelPrefsPort = deps.prefs ?? {
    getModel: () => undefined,
    getEffort: () => undefined,
    getBackend: () => undefined,
  };
  // cap=0 default ⇒ unlimited (Q5). Snapshot once per Run inside runIterator.
  const capConfig: CapConfigPort = deps.capConfig ?? { maxIterations: () => 0 };
  // No runnable catalog wired ⇒ empty snapshot. A symbolic default then has
  // nothing to resolve to (typed failure); concrete defaults are unaffected.
  const runnableCatalog: RunnableCatalogPort = deps.runnableCatalog ?? {
    snapshot: () => ({ models: [] }),
  };
  const shell: ShellRunnerPort = deps.shell ?? createDefaultShellRunner();
  // CLI streaming-spawn edge for the non-native (CLI-backed) dispatch arm.
  const cliSpawner: CliSpawnerPort = deps.cliSpawner ?? createDefaultCliSpawner();
  const fs: FsRunnerPort = deps.fs ?? createDefaultFsRunner();
  // No-op resolver when no capabilities are wired: load_skill yields isError,
  // and the Run-start listing is empty (no block injected).
  const skillResolver: SkillResolverPort = deps.skillResolver ?? {
    list: () => [],
    load: () => undefined,
  };
  // No skill projection wired ⇒ the CLI path projects nothing (no --add-dir).
  const skillProjection = deps.skillProjection;
  const fsCopy: FsCopyPort = deps.fsCopy ?? createDefaultFsCopy();
  const permission: PermissionPort = deps.permission ?? createDefaultPermission(catalog);
  const now = deps.now ?? Date.now;
  const events = new TypedEmitter<RunModuleEvents>();
  const permissionEvents = new TypedEmitter<PermissionEvents>();
  const backendEvents = new TypedEmitter<BackendEvents>();
  const registry: ToolRegistry = buildToolRegistry({
    shell,
    fs,
    skills: skillResolver,
  });
  const inflight = new Map<string, { threadId: string; controller: AbortController }>();
  const threadsWithRun = new Set<string>();

  // The Run-finalize protocol lives behind these three verbs (one per terminal
  // outcome): emit the audit event BEFORE the store mutation (ADR-0004 §Failure
  // semantics — a persist failure must fail the originating op), mutate the
  // store, then return the matching RunEvent to yield. Every backend (native
  // tool-loop, CLI, and future seam-3 arms) finalizes through these so the
  // audit-first ordering, the RunEvent shape, and the FinishReason convention
  // have one home and one test surface.

  // The Run's identity triad. Bundled into one object (Fix r2-ddd-1) so the
  // three same-typed ids can't be transposed across the audit/event path; the
  // interim object-param fix ahead of project-wide branded ids.
  type RunIdentity = { runId: string; threadId: string; agentId: string };

  async function finalizeCompleted(
    id: RunIdentity,
    finishReason: FinishReason,
    finalMessage: ThreadMessage,
  ): Promise<RunEvent> {
    const { runId, threadId, agentId } = id;
    await events.emit("run.completed", { runId, threadId, agentId, finishReason });
    runs.complete({ runId, finishReason });
    return { type: "run.completed", runId, finishReason, finalMessage, ts: now() };
  }

  async function finalizeCancelled(id: RunIdentity): Promise<RunEvent> {
    const { runId, threadId, agentId } = id;
    await events.emit("run.cancelled", { runId, threadId, agentId });
    runs.cancel(runId);
    return { type: "run.cancelled", runId, ts: now() };
  }

  async function finalizeFailed(
    id: RunIdentity,
    code: NonNullable<Run["errorCode"]>,
    message: string,
  ): Promise<RunEvent> {
    const { runId, threadId, agentId } = id;
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
        yield await finalizeFailed(
          { runId: run.id, threadId, agentId },
          "agent_not_found",
          `unknown agent: ${agentId}`,
        );
        return;
      }

      // Conversation-scope pick (S1): the Thread's model/effort, between the
      // per-Run override and the user agent default. null/absent ⇒ unset.
      const thread = threads.get(threadId);
      const threadModel = thread?.modelPref ?? undefined;
      const threadEffort = effortDefaultOrUndefined(thread?.effortPref);
      // Agent-Backend tier (ADR-0015): the Thread pick > user agent default >
      // harness backend. Both stored values are open strings; narrow to a known
      // AgentBackend on the way INTO resolve (a stale/unknown value is ignored,
      // falling through to the next tier).
      const threadBackend = backendOrUndefined(thread?.backend);
      const userBackendDefault = backendOrUndefined(prefs.getBackend(agentId));

      // Working Directory (ADR-0016 C4): resolved ONCE here — the only scope
      // holding both thread + agent — then threaded to both backends so native
      // run_shell and the CLI spawn share a cwd (keeps `claude --resume` stable).
      const agentDefaultWorkingDir =
        typeof agent.config.workingDir === "string" ? agent.config.workingDir : undefined;
      const cwd = resolveWorkingDir({
        agentId,
        threadWorkingDir: thread?.workingDir ?? null,
        ...(agentDefaultWorkingDir !== undefined ? { agentDefaultWorkingDir } : {}),
      });

      // Seam 2 — resolve model + effort + backend. The runnable catalog feeds
      // the symbolic-default resolver (S2): a "latest"/"highest" default
      // resolves to a credentialed+routable concrete model/effort here.
      const resolved = resolve({
        agentId,
        configuredModel: typeof agent.config.model === "string" ? agent.config.model : undefined,
        configuredEffort: agent.config.thinkingEffort,
        userModelDefault: prefs.getModel(agentId),
        userEffortDefault: prefs.getEffort(agentId),
        ...(threadModel !== undefined ? { threadModel } : {}),
        ...(threadEffort !== undefined ? { threadEffort } : {}),
        ...(modelOverride !== undefined ? { modelOverride } : {}),
        ...(effortOverride !== undefined ? { effortOverride } : {}),
        backend: agent.backend,
        ...(threadBackend !== undefined ? { threadBackend } : {}),
        ...(userBackendDefault !== undefined ? { userBackendDefault } : {}),
        runnableCatalog: runnableCatalog.snapshot(),
      });
      const { model } = resolved;

      // TRACE (not audit): the daemon observed an invalid stored backend axis
      // during normal resolution and fail-softed it to `native` (ADR-0015 §27).
      // The proximate cause is the system, not a fresh user action — so it goes
      // to trace. `resolve()` stays pure; the warning fires here, at the I/O edge.
      if (!("failure" in resolved) && resolved.neutralizedBackend) {
        log().warn(
          { module: "runs/resolve", agentId, backend: agent.backend },
          "neutralized non-native backend for non-Worker agent",
        );
      }

      if ("failure" in resolved) {
        // Thread the resolver's typed failure verbatim (P1). It already carries
        // the accurate GatewayErrorCode + message: `invalid_request` for a
        // malformed-model parse, `model_not_found` for a symbolic "latest" that
        // has no runnable (credentialed ∩ routable) model to resolve to. Both
        // are GatewayErrorCodes already flowing through run.failed, so no cast.
        // Previously this arm hardcoded `invalid_request` / "malformed model",
        // mislabeling the zero-credentials case (E3 made root's config.model the
        // symbolic "latest").
        const run = runs.create({ threadId, agentId, model });
        yield await finalizeFailed(
          { runId: run.id, threadId, agentId },
          resolved.failure.code,
          resolved.failure.message,
        );
        return;
      }
      const { provider, effort, backend } = resolved;

      // Auth lookup. ONLY the native backend authenticates through a Hive secret
      // (Fix r1-general-0). The CLI backends (claude-code/codex) authenticate via
      // their OWN login (claude login / codex OAuth), so they skip this gate
      // entirely — a CLI that isn't logged in fails truthfully through its own
      // nonzero exit (→ backend_exited). runCliBackend never receives Hive auth.
      let auth: CompletionInput["auth"] | undefined;
      if (backend === "native") {
        auth = await secrets.getAuth(provider);
        if (!auth) {
          const run = runs.create({ threadId, agentId, model });
          yield await finalizeFailed(
            { runId: run.id, threadId, agentId },
            "no_credentials",
            `no secret stored for provider "${provider}" — add it in Settings`,
          );
          return;
        }
      }

      // Append the user message FIRST so on-disk history matches what we send.
      threads.append({ threadId, role: "user", content: userMessage });

      // Insert the Run row, emit run.started (audit-first — see finalizeFailed note).
      const runId = crypto.randomUUID();
      await events.emit("run.started", { runId, threadId, agentId, model });
      const run = runs.create({ id: runId, threadId, agentId, model });
      const controller = new AbortController();
      inflight.set(run.id, { threadId, controller });
      yield { type: "run.started", runId: run.id, threadId, agentId, model, ts: now() };

      const boundSkills = agent.bindings.skills;
      // Tools sent for this Run: registry filtered by the Agent's bound tools.
      const boundTools: ToolDef[] | undefined = toolsForBindings(registry, agent.bindings.tools);

      // Seam 3 — backend dispatch. F replaces the non-native arms.
      switch (backend) {
        case "native": {
          // auth is set above for the native branch (the gate ran); narrow it.
          if (!auth) throw new Error("runs/executor: native backend reached without auth");
          // Progressive disclosure (N3) is a NATIVE-loop concern only. Surface
          // one-line descriptions of the Agent's bound skills at Run start
          // (CONTEXT.md); the model then decides when to `load_skill`. Misses are
          // non-fatal (F2 trace-logs them); no bound/resolvable skills ⇒ no block.
          //
          // The listing is suppressed unless `load_skill` is among the Agent's
          // bound tools: advertising skill one-liners while withholding the tool
          // that loads them would name an uncallable tool. Both conditions (skills
          // bound AND load_skill bound) must hold for the block to appear.
          //
          // The CLI arm never runs this — it discloses its own skills over the
          // projected `--add-dir` (ADR-0016), so forwarding an N3 listing there
          // would advertise a `load_skill` tool the CLI cannot call.
          const canLoadSkill = agent.bindings.tools.includes(LOAD_SKILL_TOOL_NAME);
          const skillListing = canLoadSkill ? skillResolver.list(boundSkills) : [];
          const systemPrompt = buildSystemPrompt(agent.promptBody, skillListing);
          yield* runToolLoop({
            runId: run.id,
            threadId,
            agentId,
            model,
            cwd,
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            ...(effort !== undefined ? { effort } : {}),
            auth,
            signal: controller.signal,
            ...(boundTools !== undefined ? { tools: boundTools } : {}),
            boundSkills,
            maxIterations: capConfig.maxIterations(),
          });
          return;
        }
        case "claude-code":
        case "codex": {
          // CLI path uses the authored `promptBody` ALONE — no N3 skill-listing
          // block. The CLI does its own progressive disclosure over the projected
          // `--add-dir` skills (ADR-0016: Hive runs no skill disclosure here).
          const systemPrompt = bareSystemPrompt(agent.promptBody);
          yield* runCliBackend({
            runId: run.id,
            threadId,
            agentId,
            backend,
            cwd,
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            boundSkills,
            signal: controller.signal,
          });
          return;
        }
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
    /** Resolved Working Directory for this Run (ADR-0016 C4) — native tool cwd. */
    cwd: string;
    systemPrompt?: string;
    effort?: ThinkingEffort;
    auth: CompletionInput["auth"];
    signal: AbortSignal;
    tools?: ToolDef[];
    /** The Agent's bound skill names — scopes load_skill to the frozen Harness. */
    boundSkills: readonly string[];
    /** 0 = unlimited (no cap, no grace). >0 = finite cap + one grace turn. */
    maxIterations: number;
  };

  async function* runToolLoop(args: LoopArgs): AsyncIterable<RunEvent> {
    const { runId, threadId, agentId, model, maxIterations } = args;
    const id: RunIdentity = { runId, threadId, agentId };
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
        yield await finalizeCancelled(id);
        return;
      }
      if (outcome.kind === "error") {
        yield await finalizeFailed(id, outcome.code, outcome.message);
        return;
      }

      // On the grace turn the model may still emit tool_use (tools were
      // stripped from the request, but the model can ignore that). We finalize
      // regardless, so strip the dangling tool_use blocks before persisting —
      // they have no matching tool_result and Anthropic rejects empty content.
      const content =
        graceTurn && outcome.kind === "tools" ? stripToolUse(outcome.assistant) : outcome.assistant;

      // Persist the assistant message this turn produced.
      const assistantMessage: ThreadMessage = threads.append({
        threadId,
        role: "assistant",
        content,
      });

      // No tools wanted, or this was the grace turn → finalize.
      if (outcome.kind === "text" || graceTurn) {
        yield await finalizeCompleted(id, outcome.finishReason, assistantMessage);
        return;
      }

      // outcome.kind === "tools" and not a grace turn: gate + dispatch each
      // call, then feed the tool_results back as a single user message.
      const resultBlocks: ContentBlock[] = [];
      for (const call of outcome.calls) {
        const result = await dispatchToolCall(
          runId,
          agentId,
          args.cwd,
          call,
          args.boundSkills,
          args.signal,
        );
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

  // ─── Seam 3: the CLI backend ──────────────────────────────────────────────
  //
  // One long-lived CLI process per Run (ADR-0016) — no multi-turn re-invoke
  // within a Run. Conversation continuity ACROSS Runs rides the CLI's OWN native
  // session (Fix r1-architecture-1): each CLI runs in JSON-STREAM mode, we
  // capture its session id and persist it on the Thread, and the next turn
  // RESUMEs that session — sending ONLY the latest user message, since the CLI
  // replays its own on-disk history. The JSON event stream is parsed at the
  // boundary (cli-stream.ts) into assistant text (→ the assistant message) +
  // the session id (→ persisted). stderr → Trace + a bounded tail for the
  // failure message.
  type CliArgs = {
    runId: string;
    threadId: string;
    agentId: string;
    backend: "claude-code" | "codex";
    /** Resolved Working Directory for this Run (ADR-0016 C4) — CLI spawn cwd. */
    cwd: string;
    systemPrompt?: string;
    /** The Agent's bound skill names — projected into `--add-dir` (claude-code). */
    boundSkills: readonly string[];
    signal: AbortSignal;
  };

  // Bounded stderr tail for a `run.failed` message. O(1) regardless of total
  // stderr volume: re-truncate on each chunk.
  const STDERR_TAIL_CAP = 2048;

  async function* runCliBackend(args: CliArgs): AsyncIterable<RunEvent> {
    const { runId, threadId, agentId, backend, cwd, signal } = args;
    const id: RunIdentity = { runId, threadId, agentId };

    // Create-vs-resume: resume only when the Thread carries a session id for THIS
    // backend. A stale id from a different backend is ignored (create fresh).
    const stored = threads.getCliSession(threadId);
    const mode: CliInvocationMode =
      stored && stored.backend === backend
        ? { kind: "resume", sessionId: stored.sessionId }
        : { kind: "create" };

    // The shell runner mkdir's its cwd but the CLI spawner does not — ensure the
    // per-Agent workspace exists so spawn doesn't ENOENT on a never-used agent
    // (mirrors run-shell.ts:103-107, best-effort).
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      // Best-effort — spawn surfaces a usable error if cwd is unusable.
    }

    // Capability projection (C3 / ADR-0016 "projecting spawn"). claude-code only:
    // copy the Agent's bound skills into a Hive-owned per-Run dir under the Hive
    // runtime tier (`~/.hive/agents/<id>/cli-projection/<runId>`), never inside
    // the resolved cwd, and add `--add-dir <root>` so the CLI's OWN loader
    // discloses them — Hive runs no N3 disclosure here. Skipped when no
    // projection is wired, the backend isn't claude-code, or no skills are bound.
    // codex gets no skill disclosure in v1 (its prompt rides stdin unchanged).
    let addDir: string | undefined;
    let projectionRoot: string | undefined;
    if (skillProjection && backend === "claude-code" && args.boundSkills.length > 0) {
      const skills = skillProjection.resolve(args.boundSkills);
      const skillsDir = runtimePaths.projectedCliSkillsDir(agentId, runId);
      const projected = await projectSkillsForCli({
        skills,
        skillsDir,
        copy: fsCopy.copy,
        runId,
      });
      if (projected) {
        projectionRoot = runtimePaths.projectedCliRoot(agentId, runId);
        addDir = projectionRoot;
      }
    } else if (backend === "codex" && args.boundSkills.length > 0) {
      // codex gets no skill projection in v1 (Q3 — awaits codex's own skills
      // layout). Trace the silent skip so a user who bound skills to a codex
      // Worker has a diagnostic signal rather than unexplained non-disclosure.
      log().debug(
        { module: "runs/cli", runId, agentId, backend, skillCount: args.boundSkills.length },
        "codex backend: bound skills not projected (deferred to a later slice)",
      );
    }

    const { command, stdin } = buildCliInvocation(backend, {
      ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
      history: threads.getCompletionMessages(threadId),
      mode,
      ...(addDir !== undefined ? { addDir } : {}),
    });

    // Best-effort removal of the per-Run projection dir once the Run ends (any
    // exit path). Swallowed: a failed rmdir leaves a stale dir for the next Run
    // to overwrite (keyed by runId), never a Run failure.
    const cleanupProjection = () => {
      if (projectionRoot === undefined) return;
      fsCopy.remove(projectionRoot).catch(() => {});
    };

    try {
      // Audit-first: record the spawn (redacted — binary name + arg COUNT only,
      // never the prompt/systemPrompt/flags' values/auth) BEFORE spawning.
      await backendEvents.emit("backend.spawn.requested", {
        runId,
        agentId,
        backend,
        binary: command[0] ?? backend,
        argSummary: { count: Math.max(0, command.length - 1) },
        hasStdin: stdin !== undefined,
      });

      const spawned = cliSpawner.spawn({
        command,
        cwd,
        signal,
        ...(stdin !== undefined ? { stdin } : {}),
      });

      if (spawned.kind === "spawn_failed") {
        // ENOENT / binary-missing — the CLI isn't installed/spawnable: a Run-owned
        // backend failure (Fix r1-ddd-1), not a gateway error.
        yield await finalizeFailed(
          id,
          "backend_unavailable",
          `${backend} spawn failed: ${spawned.message}`,
        );
        return;
      }

      // stderr sink: route each chunk to Trace (system diagnostics — AGENTS.md)
      // and keep an O(1) bounded tail for the failure message. Started right after
      // spawn; awaited before finalize so the tail is complete. The tail must
      // survive the stream ending, so resolve it (a bare `.catch(()=>{})` would
      // discard it).
      const stderrDone: Promise<string> = (async () => {
        let tail = "";
        try {
          for await (const chunk of spawned.stderr) {
            log().debug({ module: "runs/cli", runId, backend }, chunk);
            tail = (tail + chunk).slice(-STDERR_TAIL_CAP);
          }
        } catch {
          // stream ended / cancelled — keep whatever tail accumulated.
        }
        return tail;
      })();

      // Parse the JSON event stream at the boundary: accumulate assistant text and
      // capture the native session id. Unknown events are ignored (cli-stream.ts).
      let out = "";
      let sessionId: string | undefined;
      for await (const fact of parseCliStream(backend, spawned.stdout)) {
        if (fact.kind === "text") out += fact.text;
        else sessionId = fact.sessionId;
      }

      const { exitCode } = await spawned.exit;
      const tail = await stderrDone;

      // Cancellation precedence: a killed child exits nonzero, but an aborted
      // signal means cancel, not fail (mirrors run-shell's `killed` precedence).
      if (signal.aborted) {
        yield await finalizeCancelled(id);
        return;
      }

      if (exitCode !== 0) {
        // A logged-out CLI / runtime error surfaces here as a nonzero exit — a
        // Run-owned backend failure (Fix r1-ddd-1). The folded stderr tail carries
        // the human detail.
        yield await finalizeFailed(
          id,
          "backend_exited",
          `${backend} exited ${exitCode}${tail ? `:\n${tail}` : ""}`,
        );
        return;
      }

      // Zero exit: persist the captured session id BEFORE finalizing so a follow-up
      // turn on this Thread resumes it. Only on a create (a resume keeps the same
      // id); internal continuity state, not audited.
      if (mode.kind === "create" && sessionId !== undefined) {
        threads.setCliSession(threadId, { backend, sessionId });
      }

      // Append the assistant message and complete, mirroring the native finalize. A
      // CLI success has no gateway finish reason; "stop" is the FinishReason for
      // normal completion.
      const finalText = out.trim().length > 0 ? out : "[no output]";
      const assistantMessage: ThreadMessage = threads.append({
        threadId,
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
      yield await finalizeCompleted(id, "stop", assistantMessage);
    } finally {
      // Best-effort cleanup on every exit path (success, failure, cancel, or an
      // abandoned iterator). Fire-and-forget so a slow rmdir can't stall finalize.
      cleanupProjection();
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
    cwd: string,
    call: { id: string; name: string; input: unknown },
    boundSkills: readonly string[],
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    if (signal.aborted) {
      return { content: "run cancelled", isError: true };
    }

    // The handler projects its own gate + audit metadata — the executor never
    // knows a tool's wire shape. Command-less tools yield {} (no command).
    const handler = registry.get(call.name);
    const meta = handler?.describe?.(call.input) ?? {};
    const { command, path, argSummary, editSummary } = meta;

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
      ...(path !== undefined ? { path } : {}),
      ...(argSummary !== undefined ? { argSummary } : {}),
      ...(editSummary !== undefined ? { editSummary } : {}),
    });
    const ctx: ToolContext = {
      agentId,
      runId,
      cwd,
      boundSkills,
      signal,
    };
    const result = await handler.run(call.input, ctx);
    await events.emit("run.tool_use.executed", {
      runId,
      agentId,
      tool: call.name,
      toolUseId: call.id,
      isError: result.isError,
    });
    // Audit-first: a successful skill load surfaces its name; emit
    // run.skill_loaded (ref only — name, never body) before the tool_result is
    // fed back to the model, mirroring run.tool_use.executed.
    if (result.loadedSkill !== undefined) {
      await events.emit("run.skill_loaded", { runId, agentId, skill: result.loadedSkill });
    }
    return result;
  }

  return {
    events,
    permissionEvents,
    backendEvents,
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

// Compose the Run's system prompt: the Agent's authored prompt body + a
// one-line-per-skill listing of its bound, resolvable skills (N3 progressive
// disclosure). The model reads the listing and decides when to `load_skill`.
// Returns undefined only when BOTH the body and the listing are empty (so the
// loop omits `system` entirely); an empty skill set injects no block (no empty
// header).
function buildSystemPrompt(
  promptBody: string,
  skills: ReadonlyArray<{ name: string; description: string }>,
): string | undefined {
  const body = promptBody.trim();
  const listing =
    skills.length > 0
      ? `Available skills (call ${LOAD_SKILL_TOOL_NAME} to load one):\n${skills
          .map((s) => `- ${s.name}: ${s.description}`)
          .join("\n")}`
      : "";
  const parts = [body, listing].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// CLI-path system prompt: the authored body ALONE, no N3 skill-listing (the CLI
// discloses its own skills over `--add-dir`, ADR-0016). A blank/whitespace body
// yields undefined, matching `buildSystemPrompt`'s empty-prompt semantics.
function bareSystemPrompt(promptBody: string): string | undefined {
  const body = promptBody.trim();
  return body.length > 0 ? body : undefined;
}

// Narrow a stored Thread-scope effort (a free `string | null` column) to a
// resolver-accepted default-tier value — a concrete level or the symbolic
// "highest" — or undefined for unset / malformed. Uses the SHARED
// `isThinkingEffort` / `EffortDefault` (P3), the same narrowing resolve()'s
// harness-config path uses. The store keeps the raw `string | null`; this is a
// consumer-side narrowing on the way INTO resolve(), not a store-level tighten.
function effortDefaultOrUndefined(raw: string | null | undefined): EffortDefault | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (isThinkingEffort(raw)) return raw;
  return isSymbolicEffort(raw) ? "highest" : undefined;
}

// Narrow a stored backend value (open `string | null` from the Thread scope or
// the agent default) to a known AgentBackend on the way INTO resolve(). An
// unknown/stale value is ignored (undefined), falling through to the next tier.
function backendOrUndefined(raw: string | null | undefined): AgentBackend | undefined {
  const parsed = AgentBackend.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// Grace-turn finalize: keep only text/thinking blocks, dropping dangling
// tool_use. Falls back to a minimal text block — Anthropic rejects empty
// content, and a tool_use-only turn would otherwise strip to nothing.
function stripToolUse(content: ContentBlock[]): ContentBlock[] {
  const kept = content.filter((b) => b.type !== "tool_use");
  return kept.length > 0 ? kept : [{ type: "text", text: "[stopped: iteration cap reached]" }];
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
