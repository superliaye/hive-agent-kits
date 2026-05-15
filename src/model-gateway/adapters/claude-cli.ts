// claude-cli adapter — spawns the local `claude` CLI in non-interactive mode
// and translates its stream-json output into GatewayEvents.
//
// Invocation:
//   claude -p --output-format stream-json --verbose --include-partial-messages \
//     --model <name> [--append-system-prompt <system>] <prompt>
//
// Auth: ignored — claude-cli uses its own logged-in credentials.
//
// Scope: text only. Tool use, thinking, server tools, images deferred.

import type {
  CompletionInput,
  ContentBlock,
  FinishReason,
  GatewayAdapter,
  GatewayErrorCode,
  GatewayEvent,
  Message,
} from "../types.ts";

const PROVIDER = "claude-cli";

function flattenContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") {
        if (typeof block.content === "string") return block.content;
        return flattenContent(block.content);
      }
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
}

function buildPrompt(messages: Message[]): string {
  if (messages.length === 0) return "";
  // For v1: serialize the whole thread as alternating turns so prior context is preserved.
  // The last message is typically the user's current turn.
  if (messages.length === 1) {
    return flattenContent(messages[0]?.content ?? []);
  }
  return messages
    .map((m) => {
      const text = flattenContent(m.content);
      const label = m.role === "user" ? "User" : "Assistant";
      return `${label}: ${text}`;
    })
    .join("\n\n");
}

function mapStopReason(reason: unknown): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return "stop";
  }
}

type ClaudeStreamRecord = {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string };
    message?: { stop_reason?: string; usage?: Record<string, unknown> };
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string;
  };
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

async function* readNDJSON(stream: ReadableStream<Uint8Array>): AsyncGenerator<ClaudeStreamRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard ndjson parse pattern
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as ClaudeStreamRecord;
        } catch {
          // ignore parse failures — claude-cli sometimes interleaves non-json lines on error
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as ClaudeStreamRecord;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const claudeCliAdapter: GatewayAdapter = {
  providers: [PROVIDER],

  async *complete(input: CompletionInput): AsyncIterable<GatewayEvent> {
    const slash = input.model.indexOf("/");
    const modelName = slash >= 0 ? input.model.slice(slash + 1) : input.model;
    if (!modelName) {
      yield {
        type: "error",
        code: "invalid_request",
        message: `claude-cli adapter requires a model name after "${PROVIDER}/"`,
        retryable: false,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }

    const prompt = buildPrompt(input.messages);
    if (!prompt) {
      yield {
        type: "error",
        code: "invalid_request",
        message: "claude-cli adapter requires at least one message with text content",
        retryable: false,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      modelName,
    ];
    if (input.system && input.system.trim().length > 0) {
      args.push("--append-system-prompt", input.system);
    }
    args.push(prompt);

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["claude", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
    } catch (err) {
      yield {
        type: "error",
        code: "unknown",
        message: `failed to spawn claude CLI: ${(err as Error).message}`,
        retryable: false,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }

    const abortListener = () => {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });

    let textStarted = false;
    const textBlockIndex = 0;
    let pendingFinish: FinishReason | null = null;
    let pendingUsage: Extract<GatewayEvent, { type: "usage" }> | null = null;
    let errored = false;

    try {
      for await (const rec of readNDJSON(proc.stdout)) {
        if (input.signal?.aborted) break;

        // Streaming events (with --include-partial-messages)
        if (rec.type === "stream_event" && rec.event) {
          const ev = rec.event;
          if (
            ev.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            typeof ev.delta.text === "string" &&
            ev.delta.text.length > 0
          ) {
            if (!textStarted) {
              textStarted = true;
              yield { type: "text_start", blockIndex: textBlockIndex };
            }
            yield {
              type: "text_delta",
              blockIndex: textBlockIndex,
              delta: ev.delta.text,
            };
          } else if (ev.type === "message_delta" && ev.message?.stop_reason) {
            pendingFinish = mapStopReason(ev.message.stop_reason);
          }
          continue;
        }

        // Per-iteration assistant message (also arrives in stream-json with
        // partial messages enabled, but is a snapshot — we already streamed
        // the deltas, so we don't re-emit text here).

        // Result envelope at end of run — authoritative usage + stop reason.
        if (rec.type === "result") {
          if (rec.is_error) {
            errored = true;
            yield {
              type: "error",
              code: "unknown",
              message: typeof rec.result === "string" ? rec.result : "claude CLI reported is_error",
              retryable: false,
            };
            pendingFinish = "error";
            continue;
          }
          if (rec.usage) {
            pendingUsage = {
              type: "usage",
              inputTokens: rec.usage.input_tokens ?? 0,
              outputTokens: rec.usage.output_tokens ?? 0,
              ...(rec.usage.cache_read_input_tokens !== undefined && {
                cacheReadTokens: rec.usage.cache_read_input_tokens,
              }),
              ...(rec.usage.cache_creation_input_tokens !== undefined && {
                cacheWriteTokens: rec.usage.cache_creation_input_tokens,
              }),
            };
          }
          if (rec.stop_reason) {
            pendingFinish = mapStopReason(rec.stop_reason);
          }
          // If we never got streaming text (e.g. user ran without
          // --include-partial-messages or claude returned text only via
          // result.result), fall back to emitting it now.
          if (!textStarted && typeof rec.result === "string" && rec.result.length > 0) {
            yield { type: "text_start", blockIndex: textBlockIndex };
            yield {
              type: "text_delta",
              blockIndex: textBlockIndex,
              delta: rec.result,
            };
            textStarted = true;
          }
        }
      }
    } catch (err) {
      errored = true;
      yield {
        type: "error",
        code: "unknown",
        message: `claude CLI stream read failed: ${(err as Error).message}`,
        retryable: false,
      };
    }

    if (textStarted) {
      yield { type: "text_end", blockIndex: textBlockIndex };
    }

    let exitCode = 0;
    try {
      exitCode = await proc.exited;
    } catch {
      exitCode = -1;
    }

    input.signal?.removeEventListener("abort", abortListener);

    if (input.signal?.aborted) {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }

    if (exitCode !== 0 && !errored) {
      let stderrText = "";
      try {
        stderrText = await new Response(proc.stderr).text();
      } catch {
        // ignore
      }
      const { code, retryable } = classifyExit(exitCode, stderrText);
      yield {
        type: "error",
        code,
        message: stderrText.trim() || `claude CLI exited with code ${exitCode}`,
        retryable,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }

    if (pendingUsage) {
      yield pendingUsage;
    }

    yield { type: "done", finishReason: errored ? "error" : (pendingFinish ?? "stop") };
  },
};

function classifyExit(
  _exitCode: number,
  stderr: string,
): { code: GatewayErrorCode; retryable: boolean } {
  const lower = stderr.toLowerCase();
  if (lower.includes("unauthor") || lower.includes("not logged in") || lower.includes("401")) {
    return { code: "auth_failed", retryable: false };
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return { code: "rate_limited", retryable: true };
  }
  if (lower.includes("overloaded") || lower.includes("529")) {
    return { code: "model_overloaded", retryable: true };
  }
  if (lower.includes("not found") && lower.includes("model")) {
    return { code: "model_not_found", retryable: false };
  }
  return { code: "unknown", retryable: false };
}
