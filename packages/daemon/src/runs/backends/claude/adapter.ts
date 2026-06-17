// Claude backend adapter (spec §Claude adapter, verified against
// @anthropic-ai/claude-agent-sdk@0.3.178). Drives `query({prompt, options})`,
// folds the `SDKMessage` union into `RunEvent`s, and emits the terminal
// lifecycle event. The SDK runs its OWN tool loop (no Hive loop); this adapter
// observes that loop and forwards.
//
// Fold (spec's Claude table):
//   system/init           → capture session_id (persist for resume)
//   assistant text        → text-delta stream events + the final assistant msg
//   assistant tool_use    → observed stream event + audit backend.tool_use.observed
//   user tool_result      → carry is_error onto the observed event
//   stream_event          → fine per-token deltas (includePartialMessages)
//   result success/error  → run.completed / run.failed (classified)

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Stream } from "effect";
import type { ContentBlock } from "../../../lib/messages.ts";
import type { ThreadMessage } from "../../../threads/types.ts";
import type { RunEvent } from "../../types.ts";
import { BackendError } from "../errors.ts";
import type { BackendInvocation } from "../invocation.ts";
import type { BackendRun } from "../port.ts";
import type { BackendErrorCode, BackendStreamEvent } from "../stream-events.ts";
import { buildClaudeOptions } from "./options.ts";

// Construction-time deps the adapter discharges at its boundary. Per-Run
// session persistence + audit tool-observed are on the invocation's `callbacks`
// (the executor owns those); skill projection + the Phase-0 escape hatch are
// composition-root construction concerns.
export type ClaudeAdapterDeps = {
  /** Project bound skills to a per-Run dir, returning the plugin path (or none). */
  projectSkills?: (invocation: BackendInvocation) => Promise<string | undefined>;
  /** Best-effort cleanup of a per-Run projection dir after the Run ends. */
  cleanupSkills?: (invocation: BackendInvocation) => void;
  /** Escape hatch from Phase 0. */
  pathToClaudeCodeExecutable?: string;
  now?: () => number;
};

// Map the SDK result-error subtype / assistant error to a BackendErrorCode.
function classifyResultError(subtype: string): BackendErrorCode {
  switch (subtype) {
    case "error_max_turns":
    case "error_max_budget_usd":
      return "quota_exceeded";
    case "error_max_structured_output_retries":
      return "invalid_request";
    default:
      return "unknown";
  }
}

// Map an SDK assistant-message error to a BackendErrorCode.
function classifyAssistantError(err: string): BackendErrorCode {
  switch (err) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "auth_failed";
    case "billing_error":
      return "quota_exceeded";
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
      return "model_overloaded";
    case "invalid_request":
      return "invalid_request";
    case "model_not_found":
      return "model_not_found";
    case "max_output_tokens":
      return "content_policy";
    case "server_error":
      return "server";
    default:
      return "unknown";
  }
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): BackendRun {
  const now = deps.now ?? Date.now;

  return {
    run(invocation: BackendInvocation): Stream.Stream<RunEvent, BackendError> {
      const { runId, threadId, userMessage, mode } = invocation;

      async function* generate(): AsyncGenerator<RunEvent> {
        const pluginPath = deps.projectSkills ? await deps.projectSkills(invocation) : undefined;
        try {
          const options = buildClaudeOptions({
            invocation,
            ...(pluginPath !== undefined ? { pluginPath } : {}),
            ...(deps.pathToClaudeCodeExecutable !== undefined
              ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable }
              : {}),
          });

          // First turn (create) sends the latest user message; resume replays the
          // SDK's own stored session, so still send only the new message.
          const prompt = userMessageText(userMessage);

          let blockIndex = 0;
          const assistantBlocks: ContentBlock[] = [];
          // Track tool_use id → name so a later tool_result can be paired for audit.
          const toolNames = new Map<string, string>();
          let yieldedCompletion = false;
          // The most recent assistant-message error (e.g. auth/rate-limit), used
          // to classify a stream that ends without a terminal `result`.
          let pendingErrorCode: BackendErrorCode | undefined;

          const q = query({ prompt, options });

          // Cancellation: abort the query when the Run signal fires. The
          // interrupt is best-effort fire-and-forget — `.catch` swallows it and
          // `.finally(() => {})` discharges the promise so nothing floats.
          const onAbort = () => {
            const interrupted = q.interrupt?.();
            if (interrupted) interrupted.catch(() => {}).finally(() => {});
          };
          invocation.signal.addEventListener("abort", onAbort, { once: true });

          try {
            for await (const message of q) {
              if (message.type === "system" && message.subtype === "init") {
                if (mode.kind === "create") {
                  invocation.callbacks.persistSession(message.session_id);
                }
                continue;
              }

              if (message.type === "stream_event") {
                // Live per-token deltas (includePartialMessages) — the SOLE
                // source of streamed text so the UI shows tokens as they arrive.
                const ev = foldPartial(message.event);
                if (ev) yield { type: "model.event", runId, event: ev };
                continue;
              }

              if (message.type === "assistant") {
                if (message.error) pendingErrorCode = classifyAssistantError(message.error);
                // The finalized assistant turn: accumulate its content for the
                // persisted final message + emit tool-observed events. Text is
                // NOT re-streamed here (stream_event already did, live).
                for (const block of message.message.content) {
                  if (block.type === "text") {
                    assistantBlocks.push({ type: "text", text: block.text });
                  } else if (block.type === "tool_use") {
                    toolNames.set(block.id, block.name);
                    assistantBlocks.push({
                      type: "tool_use",
                      id: block.id,
                      name: block.name,
                      input: block.input,
                    });
                    yield {
                      type: "model.event",
                      runId,
                      event: {
                        type: "tool_use_start",
                        blockIndex,
                        id: block.id,
                        name: block.name,
                      },
                    };
                    blockIndex += 1;
                    invocation.callbacks.onToolObserved(block.name, false);
                  }
                }
                continue;
              }

              if (message.type === "user") {
                // tool_result blocks pair to a prior tool_use; carry is_error.
                const content = message.message.content;
                if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === "tool_result") {
                      const name = toolNames.get(block.tool_use_id);
                      if (name && block.is_error) invocation.callbacks.onToolObserved(name, true);
                    }
                  }
                }
                continue;
              }

              if (message.type === "result") {
                if (invocation.signal.aborted) {
                  yield { type: "run.cancelled", runId, ts: now() };
                  yieldedCompletion = true;
                  break;
                }
                if (message.subtype === "success") {
                  const text = message.result;
                  const finalContent: ContentBlock[] =
                    assistantBlocks.length > 0
                      ? assistantBlocks
                      : [{ type: "text", text: text.length > 0 ? text : "[no output]" }];
                  const finalMessage: ThreadMessage = {
                    id: crypto.randomUUID(),
                    threadId,
                    idx: 0,
                    role: "assistant",
                    content: finalContent,
                    createdAt: now(),
                  };
                  yield {
                    type: "run.completed",
                    runId,
                    finishReason: "stop",
                    finalMessage,
                    ts: now(),
                  };
                } else {
                  const code = classifyResultError(message.subtype);
                  const detail = message.errors.join("; ") || message.subtype;
                  yield {
                    type: "run.failed",
                    runId,
                    error: { code, message: `claude run failed: ${detail}` },
                    ts: now(),
                  };
                }
                yieldedCompletion = true;
                break;
              }
            }
          } finally {
            invocation.signal.removeEventListener("abort", onAbort);
          }

          if (!yieldedCompletion) {
            // The generator ended without a `result` message — fail truthfully
            // rather than hang, carrying any assistant-error classification.
            yield {
              type: "run.failed",
              runId,
              error: {
                code: pendingErrorCode ?? "unknown",
                message: "claude stream ended without a result message",
              },
              ts: now(),
            };
          }
        } catch (err) {
          yield {
            type: "run.failed",
            runId,
            error: {
              code: "backend_unavailable",
              message: `claude adapter error: ${err instanceof Error ? err.message : String(err)}`,
            },
            ts: now(),
          };
        } finally {
          deps.cleanupSkills?.(invocation);
        }
      }

      return Stream.fromAsyncIterable(
        generate(),
        (cause) =>
          new BackendError({
            code: "unknown",
            message: `claude adapter stream error: ${String(cause)}`,
          }),
      );
    },
  };
}

// The latest user message as a single text prompt (the SDK takes a string
// prompt; tool_result/image blocks are not sent as a fresh user turn here).
function userMessageText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// Fold a Beta raw stream event (per-token deltas) into a BackendStreamEvent.
// Only the text-delta path is forwarded for live token streaming; block
// boundaries are carried by the assistant message path above.
function foldPartial(event: unknown): BackendStreamEvent | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const e = event as { type?: string; delta?: { type?: string; text?: string }; index?: number };
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
    return {
      type: "text_delta",
      blockIndex: typeof e.index === "number" ? e.index : 0,
      delta: e.delta.text ?? "",
    };
  }
  return undefined;
}
