import type { FinishReason, GatewayErrorCode, GatewayEvent } from "../model-gateway/types.ts";
import type { ThreadMessage } from "../threads/types.ts";
import type { RunStatus } from "./schema.ts";

export type { RunStatus } from "./schema.ts";

export type Run = {
  id: string;
  threadId: string;
  agentId: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  finishReason?: FinishReason;
  errorCode?: GatewayErrorCode | "daemon_restart" | "no_credentials" | "agent_not_found";
  errorMessage?: string;
};

/**
 * Run event stream — what `startRun()` yields. Nested envelope so the UI's
 * SSE consumer can route lifecycle events separately from per-token deltas.
 *
 * `model.event` wraps every GatewayEvent (text_delta, tool_use_*, usage,
 * etc.). `run.completed` carries the final assistant message that was
 * persisted to the messages table. `run.failed` carries a classified error.
 */
export type RunEvent =
  | {
      type: "run.started";
      runId: string;
      threadId: string;
      agentId: string;
      model: string;
      ts: number;
    }
  | { type: "model.event"; runId: string; event: GatewayEvent }
  | {
      type: "run.completed";
      runId: string;
      finishReason: FinishReason;
      finalMessage: ThreadMessage;
      ts: number;
    }
  | {
      type: "run.failed";
      runId: string;
      error: { code: NonNullable<Run["errorCode"]>; message: string };
      ts: number;
    }
  | { type: "run.cancelled"; runId: string; ts: number };

/**
 * Module-level event stream for Audit. The audit subscriber attaches here.
 * Per-token deltas DO NOT flow through this stream — they're causally
 * owned by the streaming consumer (the HTTP route / UI) per ADR-0004's
 * audit-vs-trace boundary.
 */
export type RunModuleEvents = {
  "run.started": { runId: string; threadId: string; agentId: string; model: string };
  "run.completed": { runId: string; threadId: string; agentId: string; finishReason: FinishReason };
  "run.failed": {
    runId: string;
    threadId: string;
    agentId: string;
    code: NonNullable<Run["errorCode"]>;
    message: string;
  };
  "run.cancelled": { runId: string; threadId: string; agentId: string };
  // Tool dispatch (ADR-0004:83). `requested` is emitted (audit-first) BEFORE the
  // side effect; `executed` after it returns. Payloads carry REFS + a redacted
  // arg summary only — never raw arg strings, never stdout (ADR-0004:141, Q6).
  "run.tool_use.requested": {
    runId: string;
    agentId: string;
    tool: string;
    toolUseId: string;
    /** Command-bearing tools only: the command name (a ref, not an arg). */
    command?: string;
    /** File tools only: the confined workspace-relative path (a ref, like `command`). */
    path?: string;
    /** Redacted/elided arg summary — count only, never the values. */
    argSummary?: { count: number };
    /** `edit` only: redacted length summary — string lengths, never the content. */
    editSummary?: { oldLen: number; newLen: number };
  };
  "run.tool_use.executed": {
    runId: string;
    agentId: string;
    tool: string;
    toolUseId: string;
    isError: boolean;
  };
  // Skill progressive disclosure (N3): the model pulled a bound Skill's body via
  // `load_skill`. The skill NAME is a ref — the body NEVER enters the payload
  // (ADR-0004 redaction). Emitted audit-first, before the body returns.
  "run.skill_loaded": {
    runId: string;
    agentId: string;
    skill: string;
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
    runId: string;
    agentId: string;
    tool: string;
    /** Command-bearing tools only: command name (ref). Never raw args. */
    command?: string;
  };
  "permission.decided": {
    runId: string;
    agentId: string;
    tool: string;
    command?: string;
    outcome: "allow" | "deny";
    reason?: string;
  };
};
