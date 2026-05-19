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
  "run.completed": { runId: string; finishReason: FinishReason };
  "run.failed": { runId: string; code: NonNullable<Run["errorCode"]>; message: string };
  "run.cancelled": { runId: string };
};
