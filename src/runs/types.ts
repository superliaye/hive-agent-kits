import type { AgentBackend } from "../lib/capability-types.ts";
import type { AgentId, RunId, ThreadId } from "../lib/ids.ts";
import type { ThreadMessage } from "../threads/types.ts";
import type {
  BackendErrorCode,
  BackendStreamEvent,
  FinishReason,
} from "./backends/stream-events.ts";
import type { RunStatus } from "./schema.ts";

export type { RunStatus } from "./schema.ts";

export type Run = {
  id: RunId;
  threadId: ThreadId;
  agentId: AgentId;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  finishReason?: FinishReason;
  errorCode?:
    | BackendErrorCode
    | "daemon_restart"
    | "no_credentials"
    | "agent_not_found"
    | "backend_unavailable"
    | "backend_exited";
  errorMessage?: string;
};

/**
 * Run event stream — what `startRun()` yields. Nested envelope so the UI's
 * SSE consumer can route lifecycle events separately from per-token deltas.
 *
 * `model.event` wraps every BackendStreamEvent (text_delta, tool_use_*, usage,
 * etc.). `run.completed` carries the final assistant message that was
 * persisted to the messages table. `run.failed` carries a classified error.
 */
export type RunEvent =
  | {
      type: "run.started";
      runId: RunId;
      threadId: ThreadId;
      agentId: AgentId;
      model: string;
      ts: number;
    }
  | { type: "model.event"; runId: RunId; event: BackendStreamEvent }
  | {
      type: "run.completed";
      runId: RunId;
      finishReason: FinishReason;
      finalMessage: ThreadMessage;
      ts: number;
    }
  | {
      type: "run.failed";
      runId: RunId;
      error: { code: NonNullable<Run["errorCode"]>; message: string };
      ts: number;
    }
  | { type: "run.cancelled"; runId: RunId; ts: number };

/**
 * Module-level event stream for Audit. The audit subscriber attaches here.
 * Per-token deltas DO NOT flow through this stream — they're causally
 * owned by the streaming consumer (the HTTP route / UI) per ADR-0004's
 * audit-vs-trace boundary.
 */
export type RunModuleEvents = {
  "run.started": { runId: RunId; threadId: ThreadId; agentId: AgentId; model: string };
  "run.completed": {
    runId: RunId;
    threadId: ThreadId;
    agentId: AgentId;
    finishReason: FinishReason;
  };
  "run.failed": {
    runId: RunId;
    threadId: ThreadId;
    agentId: AgentId;
    code: NonNullable<Run["errorCode"]>;
    message: string;
  };
  "run.cancelled": { runId: RunId; threadId: ThreadId; agentId: AgentId };
};

/**
 * Dedicated `backend` AuditSource event map (ADR-0004; audit/types.ts source
 * `"backend"`). A Run dispatches to one vendor-SDK backend; this records THAT
 * dispatch (backend kind + model refs — the SDK owns argv now, so there is no
 * binary/args to record). Emitted on a SEPARATE TypedEmitter (the executor's
 * `backendEvents`), audit-first before dispatch.
 */
export type BackendEvents = {
  "backend.run.started": {
    runId: RunId;
    agentId: AgentId;
    backend: AgentBackend;
    /** The resolved model (a non-secret ref, e.g. "anthropic/claude-opus"). */
    model: string;
  };
  // A tool the SDK backend ran, observed from its event stream. OBSERVED-after-
  // the-fact (the SDK ran it under its own bypass governance; this is NOT a
  // permission decision). REFS only: the tool NAME + an `isError` boolean, never
  // args/output (ADR-0004 redaction).
  "backend.tool_use.observed": {
    runId: RunId;
    agentId: AgentId;
    backend: AgentBackend;
    /** The tool name (a ref). Never the tool's args or output. */
    tool: string;
    /** Whether the observed tool errored (a boolean ref, never the content). */
    isError: boolean;
  };
};
