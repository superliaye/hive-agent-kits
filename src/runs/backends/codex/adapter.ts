// Codex backend adapter (spec §Codex adapter, verified against
// @openai/codex-sdk@0.140.0). Drives
// `new Codex(opts).startThread(threadOpts).runStreamed(input)` (or
// `resumeThread(id)`), folds the `ThreadEvent`/`ThreadItem` stream into
// `RunEvent`s, and emits the terminal lifecycle event.
//
// Fold (spec's Codex table):
//   thread.started               → capture thread_id (persist for resume)
//   item agent_message           → text stream events + the final assistant msg
//   item command_execution       → observed + audit backend.tool_use.observed
//   item file_change             → observed (file mutation)
//   item mcp_tool_call           → observed (Hive-capability tool call)
//   turn.completed (usage)       → run.completed
//   turn.failed / top-level error → run.failed (classified)

import { Codex } from "@openai/codex-sdk";
import { Stream } from "effect";
import type { ContentBlock } from "../../../lib/messages.ts";
import type { ThreadMessage } from "../../../threads/types.ts";
import type { RunEvent } from "../../types.ts";
import { BackendError } from "../errors.ts";
import type { BackendInvocation } from "../invocation.ts";
import type { BackendRun } from "../port.ts";
import { buildCodexOptions } from "./options.ts";

export type CodexAdapterDeps = {
  /** Project bound skills to the workspace .agents/skills before the turn. */
  projectSkills?: (invocation: BackendInvocation) => Promise<void>;
  now?: () => number;
};

export function createCodexAdapter(deps: CodexAdapterDeps = {}): BackendRun {
  const now = deps.now ?? Date.now;

  return {
    run(invocation: BackendInvocation): Stream.Stream<RunEvent, BackendError> {
      const { runId, threadId, userMessage, mode } = invocation;

      async function* generate(): AsyncGenerator<RunEvent> {
        if (deps.projectSkills) await deps.projectSkills(invocation);

        const { codex, thread: threadOpts } = buildCodexOptions(invocation);
        const client = new Codex(codex);
        const thread =
          mode.kind === "resume"
            ? client.resumeThread(mode.sessionId, threadOpts)
            : client.startThread(threadOpts);

        const prompt = userMessageText(userMessage);
        let blockIndex = 0;
        let assistantText = "";
        let yieldedCompletion = false;

        try {
          const { events } = await thread.runStreamed(prompt, { signal: invocation.signal });
          for await (const event of events) {
            if (event.type === "thread.started") {
              if (mode.kind === "create") {
                invocation.callbacks.persistSession(event.thread_id);
              }
              continue;
            }

            if (event.type === "item.completed" || event.type === "item.started") {
              const item = event.item;
              if (item.type === "agent_message" && event.type === "item.completed") {
                // Codex delivers the agent message text on completion; stream it
                // as one delta block (no finer granularity exposed by the SDK).
                assistantText += item.text;
                yield { type: "model.event", runId, event: { type: "text_start", blockIndex } };
                yield {
                  type: "model.event",
                  runId,
                  event: { type: "text_delta", blockIndex, delta: item.text },
                };
                yield { type: "model.event", runId, event: { type: "text_end", blockIndex } };
                blockIndex += 1;
              } else if (event.type === "item.completed") {
                // Tool-shaped items → observed (REFS only). command_execution
                // carries an exit_code; file_change / mcp_tool_call carry status.
                if (item.type === "command_execution") {
                  const isError = item.status === "failed" || (item.exit_code ?? 0) !== 0;
                  invocation.callbacks.onToolObserved("command_execution", isError);
                } else if (item.type === "file_change") {
                  invocation.callbacks.onToolObserved("file_change", item.status === "failed");
                } else if (item.type === "mcp_tool_call") {
                  invocation.callbacks.onToolObserved(
                    `${item.server}/${item.tool}`,
                    item.status === "failed",
                  );
                }
              }
              continue;
            }

            if (event.type === "turn.completed") {
              if (invocation.signal.aborted) {
                yield { type: "run.cancelled", runId, ts: now() };
                yieldedCompletion = true;
                break;
              }
              const finalContent: ContentBlock[] = [
                { type: "text", text: assistantText.length > 0 ? assistantText : "[no output]" },
              ];
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
              yieldedCompletion = true;
              break;
            }

            if (event.type === "turn.failed") {
              yield {
                type: "run.failed",
                runId,
                error: { code: "unknown", message: `codex turn failed: ${event.error.message}` },
                ts: now(),
              };
              yieldedCompletion = true;
              break;
            }

            if (event.type === "error") {
              yield {
                type: "run.failed",
                runId,
                error: { code: "unknown", message: `codex error: ${event.message}` },
                ts: now(),
              };
              yieldedCompletion = true;
              break;
            }
          }
        } catch (err) {
          yield {
            type: "run.failed",
            runId,
            error: {
              code: "backend_unavailable",
              message: `codex adapter error: ${err instanceof Error ? err.message : String(err)}`,
            },
            ts: now(),
          };
          return;
        }

        if (!yieldedCompletion) {
          yield {
            type: "run.failed",
            runId,
            error: { code: "unknown", message: "codex stream ended without a terminal turn event" },
            ts: now(),
          };
        }
      }

      return Stream.fromAsyncIterable(
        generate(),
        (cause) =>
          new BackendError({
            code: "unknown",
            message: `codex adapter stream error: ${String(cause)}`,
          }),
      );
    },
  };
}

// The latest user message as a single text prompt (Codex takes a string input).
function userMessageText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
