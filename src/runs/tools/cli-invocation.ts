// Pure CLI-invocation assembly — turns a Run's Thread-derived prompt + projected
// systemPrompt + create/resume mode into the `{ command, stdin }` a
// CliSpawnerPort consumes. No subprocess, no I/O: testable in isolation
// (ADR-0016 "config is assembled, not authored").
//
// Each CLI runs in JSON-STREAM mode so the dispatch arm can BOTH capture the
// CLI's native session id AND stream assistant text:
//   - claude-code: `-p --output-format stream-json --verbose`; session id from
//     the init event, assistant text from assistant events, done from result.
//   - codex: `exec --json`; session id is the `thread.started` event's
//     `thread_id`.
// CREATE starts a fresh native session; RESUME re-attaches the CLI to its own
// on-disk history by the stored id (claude `--resume <id>`, codex
// `exec resume <id>`), so only the latest user turn is sent — the CLI replays
// the rest. The prompt rides STDIN (not argv) to avoid OS argv-length limits and
// shell-quoting, and to dodge the documented `codex exec "<arg>"` non-TTY-stdin
// hang (openai/codex#20919) — stdin EOF is the prompt boundary.

import type { AgentBackend } from "../../lib/capability-types.ts";
import type { Message } from "../../model-gateway/types.ts";

export type CliInvocation = {
  command: string[];
  stdin?: string;
};

// Create a fresh CLI session, or resume the CLI's own on-disk session by id.
export type CliInvocationMode = { kind: "create" } | { kind: "resume"; sessionId: string };

export type BuildCliInvocationInput = {
  /** The Run's projected instructions (Agent promptBody + N3 skill listing). */
  systemPrompt?: string;
  /** Thread completion history — the latest `role:"user"` entry is the prompt. */
  history: readonly Message[];
  /** Create a new native session, or resume a stored one. Default: create. */
  mode?: CliInvocationMode;
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
  const mode = input.mode ?? { kind: "create" };

  switch (backend) {
    case "claude-code": {
      // JSON-stream mode. systemPrompt → `--append-system-prompt`; prompt on
      // stdin. No `--bare`: default mode lets the CLI use its own auth +
      // repo-local config (ADR-0016). RESUME appends `--resume <id>`.
      const command = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
      if (mode.kind === "resume") command.push("--resume", mode.sessionId);
      if (systemPrompt !== undefined) command.push("--append-system-prompt", systemPrompt);
      return { command, stdin: promptText };
    }
    case "codex": {
      // `codex exec --json` (CREATE) / `codex exec resume <id> --json` (RESUME)
      // with stdin as the prompt. No system-prompt flag, so fold systemPrompt
      // into the prompt text. The `-` stdin sentinel is implied: stdin EOF marks
      // the prompt boundary.
      const command =
        mode.kind === "resume"
          ? ["codex", "exec", "resume", mode.sessionId, "--json", "-"]
          : ["codex", "exec", "--json", "-"];
      const stdin = systemPrompt !== undefined ? `${systemPrompt}\n\n${promptText}` : promptText;
      return { command, stdin };
    }
  }
}
