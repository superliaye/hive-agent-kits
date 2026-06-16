// Canonical backend stream-event vocabulary. The two SDK adapters (Claude,
// Codex) fold their vendor streams into `BackendStreamEvent`s;
// `RunEvent.model.event` wraps each one, so the UI's SSE consumer sees the
// unchanged envelope (types.ts).

import { Data } from "effect";

// Why a Run ended. `stop` = normal completion; `tool_use` = the model paused on
// a tool call; `error`/`cancelled` are terminal-with-reason.
export type FinishReason =
  | "stop"
  | "tool_use"
  | "length"
  | "content_policy"
  | "refusal"
  | "pause"
  | "error"
  | "cancelled";

// Backend-neutral error-code union. A backend adapter
// classifies an SDK `result(error)` / `turn.failed` / spawn failure into one of
// these; they flow through `run.failed`'s `errorCode`.
export type BackendErrorCode =
  | "auth_failed"
  | "quota_exceeded"
  | "rate_limited"
  | "model_overloaded"
  | "context_too_long"
  | "invalid_request"
  | "model_not_found"
  | "content_policy"
  | "network"
  | "server"
  | "unknown";

const RETRYABLE: ReadonlySet<BackendErrorCode> = new Set<BackendErrorCode>([
  "rate_limited",
  "model_overloaded",
  "network",
  "server",
]);

export function isRetryable(code: BackendErrorCode): boolean {
  return RETRYABLE.has(code);
}

// The per-token / per-block stream vocabulary an adapter emits. Mirrors
// Anthropic's content-block semantics (parallel blocks
// keyed by `blockIndex`, deltas append, `_end` finalizes) — the shape the
// accumulator and the UI both already understand.
export type BackendStreamEvent =
  // Text blocks
  | { type: "text_start"; blockIndex: number }
  | { type: "text_delta"; blockIndex: number; delta: string }
  | { type: "text_end"; blockIndex: number }
  // Thinking / reasoning blocks
  | { type: "thinking_start"; blockIndex: number }
  | { type: "thinking_delta"; blockIndex: number; delta: string }
  | {
      type: "thinking_end";
      blockIndex: number;
      providerMetadata?: Record<string, unknown>;
    }
  // Refusal stream
  | { type: "refusal_delta"; delta: string }
  // Client-executed tools
  | { type: "tool_use_start"; blockIndex: number; id: string; name: string }
  | { type: "tool_use_delta"; blockIndex: number; id: string; delta: string }
  | { type: "tool_use_end"; blockIndex: number; id: string; args: unknown }
  // Server-executed tools
  | {
      type: "server_tool";
      blockIndex: number;
      id: string;
      name: string;
      phase: "start" | "progress" | "result";
      payload?: unknown;
    }
  // Termination
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: "done"; finishReason: FinishReason }
  | {
      type: "error";
      code: BackendErrorCode;
      message: string;
      retryable: boolean;
    };

// Typed failure value for an adapter's Effect `E` channel.
// A spawn/auth/classification error is a value, not a throw (AGENTS.md typed
// error channel).
export class BackendFailure extends Data.TaggedError("BackendFailure")<{
  readonly code: BackendErrorCode;
  readonly message: string;
}> {
  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

export function toErrorEvent(
  failure: BackendFailure,
): Extract<BackendStreamEvent, { type: "error" }> {
  return {
    type: "error",
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}
