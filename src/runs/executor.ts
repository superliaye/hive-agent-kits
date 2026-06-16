// Run executor — the Thread → Run → event-stream loop, over the vendor-SDK
// backends (ADR-0019). One verb: `startRun({ threadId, userMessage })` returns
// an AsyncIterable<RunEvent>. The lifecycle:
//
//   1. Resolve Thread → Agent → model + effort + backend + auth. If anything
//      missing, emit `run.failed` and stop.
//   2. Append the user message to the Thread.
//   3. Insert a `running` Run row, emit `run.started`.
//   4. Build a BackendInvocation and dispatch to the resolved backend's adapter
//      (claude-code → Claude adapter, codex → Codex adapter). The SDK runs its
//      OWN tool loop; the adapter folds its stream into RunEvents.
//   5. Forward the adapter's RunEvents; finalize through the finalize verbs.
//
// Concurrency: one in-flight Run per Thread. A second `startRun` on the same
// thread while one is active throws synchronously — caller bug, not a Run
// failure (no Run row is created for the rejected request).

import { Stream } from "effect";
import { AgentBackend } from "../lib/capability-types.ts";
import type { ThinkingEffort } from "../lib/effort.ts";
import { type AgentId, RunId, ThreadId } from "../lib/ids.ts";
import type { ContentBlock } from "../lib/messages.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import { type BackendAdapters, dispatch } from "./backends/dispatch.ts";
import type { BackendInvocation, InvocationSkill } from "./backends/invocation.ts";
import type { FinishReason } from "./backends/stream-events.ts";
import { MODEL_FALLBACK } from "./defaults.ts";
import type {
  AgentModelPrefsPort,
  CatalogPort,
  RunnableCatalogPort,
  RunsStorePort,
  SecretsPort,
  SkillProjectionPort,
  ThreadsPort,
} from "./effect/ports.ts";
import { resolve } from "./resolve.ts";
import { type EffortDefault, isSymbolicEffort, isThinkingEffort } from "./symbolic.ts";
import type { BackendEvents, Run, RunEvent, RunModuleEvents } from "./types.ts";
import { resolveWorkingDir } from "./working-dir.ts";

export type StartRunInput = {
  threadId: string;
  userMessage: ContentBlock[];
  /** Optional per-Run model override; falls back to Agent's harness config, then deployment default. */
  modelOverride?: string;
  /** Optional per-Run thinking-effort override; falls back to the agent default, then provider default. */
  effortOverride?: ThinkingEffort;
};

export type RunExecutor = {
  startRun(input: StartRunInput): AsyncIterable<RunEvent>;
  getRun(runId: string): Run | undefined;
  cancelRun(runId: string): void;
  listByThread(threadId: string): Run[];
  newestTerminalRun(
    threadId: string,
  ): { status: "completed" | "failed" | "cancelled"; endedAt: number } | null;
  isThreadBusy(threadId: string): boolean;
  /** Module event stream — audit subscribes here for lifecycle. */
  events: TypedEmitter<RunModuleEvents>;
  /** Dedicated `backend` AuditSource stream — backend run + tool-observed events. */
  backendEvents: TypedEmitter<BackendEvents>;
};

export type CreateRunExecutorDeps = {
  threads: ThreadsPort;
  runs: RunsStorePort;
  catalog: CatalogPort;
  secrets: SecretsPort;
  /** The two SDK backend adapters, keyed by the resolved backend id. */
  adapters: BackendAdapters;
  /** The capability MCP endpoint both adapters connect to (local HTTP URL). */
  mcpEndpoint: string;
  /** User's per-agent model + effort + backend defaults. */
  prefs?: AgentModelPrefsPort;
  /** Runnable model catalog (credentialed ∩ routable, newest-first). */
  runnableCatalog?: RunnableCatalogPort;
  /** Resolves bound skills to projectable {name, path, origin}. */
  skillProjection?: SkillProjectionPort;
  now?: () => number;
};

export function createRunExecutor(deps: CreateRunExecutorDeps): RunExecutor {
  const { threads, runs, catalog, secrets, adapters, mcpEndpoint } = deps;
  const prefs: AgentModelPrefsPort = deps.prefs ?? {
    getModel: () => undefined,
    getEffort: () => undefined,
    getBackend: () => undefined,
  };
  const runnableCatalog: RunnableCatalogPort = deps.runnableCatalog ?? {
    snapshot: () => ({ models: [] }),
  };
  const skillProjection = deps.skillProjection;
  const now = deps.now ?? Date.now;
  const events = new TypedEmitter<RunModuleEvents>();
  const backendEvents = new TypedEmitter<BackendEvents>();
  const inflight = new Map<string, { threadId: string; controller: AbortController }>();
  const threadsWithRun = new Set<string>();

  type RunIdentity = { runId: RunId; threadId: ThreadId; agentId: AgentId };

  async function finalizeCompleted(id: RunIdentity, finishReason: FinishReason): Promise<void> {
    const { runId, threadId, agentId } = id;
    await events.emit("run.completed", { runId, threadId, agentId, finishReason });
    runs.complete({ runId, finishReason });
  }

  async function finalizeCancelled(id: RunIdentity): Promise<void> {
    const { runId, threadId, agentId } = id;
    await events.emit("run.cancelled", { runId, threadId, agentId });
    runs.cancel(runId);
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

  async function* runIterator(input: StartRunInput, agentId: AgentId): AsyncIterable<RunEvent> {
    const { userMessage, modelOverride, effortOverride } = input;
    const threadId = ThreadId.parse(input.threadId);
    try {
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

      const thread = threads.get(threadId);
      const threadModel = thread?.modelPref ?? undefined;
      const threadEffort = effortDefaultOrUndefined(thread?.effortPref);
      const threadBackend = backendOrUndefined(thread?.backend);
      const userBackendDefault = backendOrUndefined(prefs.getBackend(agentId));

      const agentDefaultWorkingDir =
        typeof agent.config.workingDir === "string" ? agent.config.workingDir : undefined;
      const cwd = resolveWorkingDir({
        agentId,
        threadWorkingDir: thread?.workingDir ?? null,
        ...(agentDefaultWorkingDir !== undefined ? { agentDefaultWorkingDir } : {}),
      });

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

      if ("failure" in resolved) {
        const run = runs.create({ threadId, agentId, model });
        yield await finalizeFailed(
          { runId: run.id, threadId, agentId },
          resolved.failure.code,
          resolved.failure.message,
        );
        return;
      }
      const { provider, effort, backend } = resolved;

      // With native deleted, only the two SDK backends remain. A stored/stale
      // `native` value can no longer resolve (the enum drops it); guard anyway so
      // a future unknown backend fails truthfully rather than dispatching nowhere.
      if (backend !== "claude-code" && backend !== "codex") {
        const run = runs.create({ threadId, agentId, model });
        yield await finalizeFailed(
          { runId: run.id, threadId, agentId },
          "backend_unavailable",
          `unsupported backend: ${backend}`,
        );
        return;
      }

      // Auth from Secrets (provider → AuthInput). Optional: when absent, the SDK
      // falls back to its own ambient login (CLAUDE_CODE_OAUTH_TOKEN / cached
      // ~/.codex/auth.json) — a logged-out SDK fails truthfully through its own
      // stream, surfaced as a classified run.failed by the adapter.
      const auth = await secrets.getAuth(provider);

      threads.append({ threadId, role: "user", content: userMessage });

      const runId = RunId.parse(crypto.randomUUID());
      await events.emit("run.started", { runId, threadId, agentId, model });
      const run = runs.create({ id: runId, threadId, agentId, model });
      const controller = new AbortController();
      inflight.set(run.id, { threadId, controller });
      yield { type: "run.started", runId: run.id, threadId, agentId, model, ts: now() };

      const id: RunIdentity = { runId: run.id, threadId, agentId };

      // Audit-first: record the backend run start (backend + model refs only —
      // the SDK owns argv now, so there is no binary/args to record).
      await backendEvents.emit("backend.run.started", { runId: run.id, agentId, backend, model });

      // Create-vs-resume from the Thread's stored CLI session for THIS backend.
      const stored = threads.getCliSession(threadId);
      const mode =
        stored && stored.backend === backend
          ? ({ kind: "resume", sessionId: stored.sessionId } as const)
          : ({ kind: "create" } as const);

      const skills: InvocationSkill[] = skillProjection
        ? skillProjection.resolve(agent.bindings.skills)
        : [];

      const invocation: BackendInvocation = {
        runId: run.id,
        threadId,
        agentId,
        backend,
        userMessage,
        history: threads.getCompletionMessages(threadId),
        systemPrompt: agent.promptBody.trim(),
        cwd,
        model,
        provider,
        ...(effort !== undefined ? { effort } : {}),
        ...(auth !== undefined ? { auth } : {}),
        skills,
        mode,
        mcpEndpoint,
        signal: controller.signal,
        callbacks: {
          persistSession: (sessionId) => {
            threads.setCliSession(threadId, { backend, sessionId });
          },
          // The adapter folds a tool the SDK ran; record it audit-first (REFS
          // only — tool name + isError). Fire-and-forget so the fold isn't stalled
          // by the audit emit; an emit failure is non-fatal to the Run stream.
          onToolObserved: (tool, isError) => {
            backendEvents
              .emit("backend.tool_use.observed", { runId: run.id, agentId, backend, tool, isError })
              .catch(() => {})
              .finally(() => {});
          },
        },
      };

      // Dispatch to the resolved adapter; forward its RunEvents. The adapter
      // emits the terminal lifecycle event; the executor mirrors it into the
      // store + audit through the finalize verbs.
      const stream = dispatch(adapters, invocation);
      for await (const event of Stream.toAsyncIterable(stream)) {
        if (event.type === "run.completed") {
          // The final assistant message rides the event; append it to Thread
          // history so the next turn replays it.
          threads.append({
            threadId,
            role: "assistant",
            content: event.finalMessage.content,
          });
          await finalizeCompleted(id, event.finishReason);
          yield event;
        } else if (event.type === "run.failed") {
          yield await finalizeFailed(id, event.error.code, event.error.message);
        } else if (event.type === "run.cancelled") {
          await finalizeCancelled(id);
          yield event;
        } else {
          // model.event (text/tool deltas) fold straight through to the UI.
          yield event;
        }
      }
    } finally {
      threadsWithRun.delete(threadId);
      for (const [rid, entry] of inflight) {
        if (entry.threadId === threadId) inflight.delete(rid);
      }
    }
  }

  return {
    events,
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

// Narrow a stored Thread-scope effort to a resolver default-tier value.
function effortDefaultOrUndefined(raw: string | null | undefined): EffortDefault | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (isThinkingEffort(raw)) return raw;
  return isSymbolicEffort(raw) ? "highest" : undefined;
}

// Narrow a stored backend value to a known AgentBackend on the way INTO resolve.
function backendOrUndefined(raw: string | null | undefined): AgentBackend | undefined {
  const parsed = AgentBackend.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
