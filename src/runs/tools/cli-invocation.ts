// Pure CLI-invocation assembly — turns a Run's Thread-derived prompt + projected
// systemPrompt into the `{ command, stdin }` a CliSpawnerPort consumes. No
// subprocess, no I/O: testable in isolation (ADR-0016 "config is assembled, not
// authored").
//
// v1 runs each CLI in its DEFAULT TEXT MODE — no stream-json/JSON-Lines parsing.
// claude prints the assistant's final text to stdout; codex prints the final
// message to stdout (progress → stderr). The prompt rides STDIN (not argv) to
// avoid OS argv-length limits and shell-quoting, and to dodge the documented
// `codex exec "<arg>"` non-TTY-stdin hang (openai/codex#20919) — `exec -`
// consumes stdin as the prompt and the adapter closes it (EOF).

import type { AgentBackend } from "../../lib/capability-types.ts";
import type { Message } from "../../model-gateway/types.ts";

export type CliInvocation = {
  command: string[];
  stdin?: string;
};

export type BuildCliInvocationInput = {
  /** The Run's projected instructions (Agent promptBody + N3 skill listing). */
  systemPrompt?: string;
  /** Thread completion history — the latest `role:"user"` entry is the prompt. */
  history: readonly Message[];
};

// Flatten a user message's text blocks to a single string. Non-text blocks
// (images / tool_result) aren't expected on a fresh user turn — drop them.
export function flattenUserText(message: Message): string {
  return message.content
    .filter((b): b is Extract<Message["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// The prompt text = the latest `role:"user"` message's flattened text. The user
// message is appended before the dispatch switch, so it is the last user entry.
function latestUserText(history: readonly Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === "user") return flattenUserText(m);
  }
  return "";
}

export function buildCliInvocation(
  backend: Extract<AgentBackend, "claude-code" | "codex">,
  input: BuildCliInvocationInput,
): CliInvocation {
  const promptText = latestUserText(input.history);
  const systemPrompt = input.systemPrompt;

  switch (backend) {
    case "claude-code": {
      // Default text mode. systemPrompt → `--append-system-prompt`; prompt on
      // stdin. No `--bare`: default mode lets the CLI use its own auth +
      // repo-local config (ADR-0016).
      const command =
        systemPrompt !== undefined
          ? ["claude", "-p", "--append-system-prompt", systemPrompt]
          : ["claude", "-p"];
      return { command, stdin: promptText };
    }
    case "codex": {
      // `codex exec -` = stdin is the full prompt. No system-prompt flag, so
      // fold systemPrompt into the prompt text.
      const stdin = systemPrompt !== undefined ? `${systemPrompt}\n\n${promptText}` : promptText;
      return { command: ["codex", "exec", "-"], stdin };
    }
  }
}
