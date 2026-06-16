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
  // Tool dispatch (ADR-0004:83). `requested` is emitted (audit-first) BEFORE the
  // side effect; `executed` after it returns. Payloads carry REFS + a redacted
  // arg summary only — never raw arg strings, never stdout (ADR-0004:141, Q6).
  "run.tool_use.requested": {
    runId: RunId;
    agentId: AgentId;
    tool: string;
    toolUseId: string;
    /** Command-bearing tools only: the command name (a ref, not an arg). */
    command?: string;
    /** File tools only: the model-supplied workspace-relative path (the call's target ref, like `command`). */
    path?: string;
    /** Redacted/elided arg summary — count only, never the values. */
    argSummary?: { count: number };
    /** `edit` only: redacted length summary — string lengths, never the content. */
    editSummary?: { oldLen: number; newLen: number };
  };
  "run.tool_use.executed": {
    runId: RunId;
    agentId: AgentId;
    tool: string;
    toolUseId: string;
    isError: boolean;
  };
  // Skill progressive disclosure (N3): the model pulled a bound Skill's body via
  // `load_skill`. The skill NAME is a ref — the body NEVER enters the payload
  // (ADR-0004 redaction). Emitted audit-first, before the body returns.
  "run.skill_loaded": {
    runId: RunId;
    agentId: AgentId;
    skill: string;
  };
};

/**
 * Dedicated `backend` AuditSource event map (ADR-0004; audit/types.ts source
 * `"backend"`). A CLI-backed Run spawns one long-lived process; this records
 * THAT spawn (not a tool dispatch — no toolUseId, no permission gate). Emitted
 * on a SEPARATE TypedEmitter (the executor's `backendEvents`), audit-first
 * before `cliSpawner.spawn(...)`. Payload carries REFS only — the binary NAME +
 * an arg COUNT (never the prompt, the systemPrompt, the flags' values, or auth),
 * mirroring `run.tool_use.requested`'s redaction.
 */
export type BackendEvents = {
  "backend.spawn.requested": {
    runId: RunId;
    agentId: AgentId;
    backend: AgentBackend;
    /** command[0] — the binary name, a ref (e.g. "claude"). */
    binary: string;
    /** Redacted arg summary — count only, never the values. */
    argSummary: { count: number };
    /** Whether a prompt rode stdin. No content — a presence flag. */
    hasStdin: boolean;
  };
  // A tool the CLI backend ran, recovered from its JSON event stream (P1.3, Q3).
  // OBSERVED-after-the-fact — the CLI ran it and owns the permission gate (P1.2
  // floor); this is NOT a permission decision. REFS only: the tool NAME + an
  // `isError` boolean, never args/output (ADR-0004 redaction). The CLI exposes no
  // per-decision permission event to parse — end-of-run `permission_denials[]` is
  // the only signal.
  "backend.tool_use.observed": {
    runId: RunId;
    agentId: AgentId;
    backend: AgentBackend;
    /** The tool name (a ref). Never the tool's args or output. */
    tool: string;
    /**
     * Whether the observed tool errored — read off the matched `tool_result`'s
     * `is_error` (a boolean ref mirroring `run.tool_use.executed`'s `isError`).
     * Records WHETHER it errored, never the error content (ADR-0004 refs).
     */
    isError: boolean;
  };
};

/**
 * Dedicated `permission` AuditSource event map (ADR-0004:81, Q4). Emitted on a
 * SEPARATE TypedEmitter (not the run emitter) so the permission decision lands
 * on its own audit source. The full G2 Permission System is unbuilt; F1 carves
 * this audit seam now.
 */
export type PermissionEvents = {
  "permission.requested": {
    runId: RunId;
    agentId: AgentId;
    tool: string;
    /** Command-bearing tools only: command name (ref). Never raw args. */
    command?: string;
  };
  "permission.decided": {
    runId: RunId;
    agentId: AgentId;
    tool: string;
    command?: string;
    outcome: "allow" | "deny";
    reason?: string;
  };
};
