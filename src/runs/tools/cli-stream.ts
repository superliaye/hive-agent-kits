// CLI JSON-event-stream parsing (ADR-0016) — the boundary between a CLI
// backend's raw stdout chunks and the normalized facts the dispatch arm needs:
// the assistant text to surface, and the native session id to persist.
//
// The C2a stdout is an AsyncIterable<string> of decoded byte chunks that do NOT
// align to event boundaries. We buffer, split on newlines, JSON.parse each
// complete line, and Zod-validate it at this boundary (AGENTS.md: Zod at every
// external boundary). Unknown/extra event types are IGNORED, never fatal — a CLI
// emits many event kinds and adds more across versions; we extract only what we
// model and skip the rest.
//
// claude `--output-format stream-json` event shapes (the subset we read):
//   {"type":"system","subtype":"init","session_id":"..."}      → session id
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//   {"type":"result", ...}                                      → done marker
// codex `exec --json` event shapes (the subset we read):
//   {"type":"thread.started","thread_id":"..."}                → session id
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   (codex's session token is `thread_id`, not `session_id`.)

import { z } from "zod";

export type CliBackend = "claude-code" | "codex";

// A normalized fact extracted from one CLI event. The dispatch arm folds these:
// `text` accumulates into the assistant message; `sessionId` is captured for
// persistence. An unmodeled event yields nothing (parsed → no fact).
export type CliStreamFact = { kind: "session"; sessionId: string } | { kind: "text"; text: string };

// ─── claude-code stream-json ──────────────────────────────────────────────────

const claudeInit = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
});

const claudeAssistant = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  }),
});

function parseClaudeEvent(value: unknown): CliStreamFact[] {
  const init = claudeInit.safeParse(value);
  if (init.success) return [{ kind: "session", sessionId: init.data.session_id }];

  const asst = claudeAssistant.safeParse(value);
  if (asst.success) {
    return asst.data.message.content
      .filter((b): b is { type: string; text: string } => b.type === "text" && b.text !== undefined)
      .map((b) => ({ kind: "text", text: b.text }) satisfies CliStreamFact);
  }
  return [];
}

// ─── codex exec --json ────────────────────────────────────────────────────────

const codexThreadStarted = z.object({
  type: z.literal("thread.started"),
  thread_id: z.string(),
});

const codexItemCompleted = z.object({
  type: z.literal("item.completed"),
  item: z.object({ type: z.string(), text: z.string().optional() }),
});

function parseCodexEvent(value: unknown): CliStreamFact[] {
  const started = codexThreadStarted.safeParse(value);
  if (started.success) return [{ kind: "session", sessionId: started.data.thread_id }];

  const item = codexItemCompleted.safeParse(value);
  if (
    item.success &&
    item.data.item.type === "agent_message" &&
    item.data.item.text !== undefined
  ) {
    return [{ kind: "text", text: item.data.item.text }];
  }
  return [];
}

// Parse one already-JSON-decoded event into its normalized facts. A line that
// JSON-parses but matches no modeled shape yields []. Exported for unit testing.
export function parseCliEvent(backend: CliBackend, value: unknown): CliStreamFact[] {
  return backend === "claude-code" ? parseClaudeEvent(value) : parseCodexEvent(value);
}

// Line-buffer + JSON.parse + normalize a raw stdout chunk stream into a flat
// stream of facts. Malformed (non-JSON) lines are skipped (a CLI may interleave
// non-JSONL noise on stdout); a partial trailing line is held until its newline
// arrives, then flushed at stream end.
export async function* parseCliStream(
  backend: CliBackend,
  chunks: AsyncIterable<string>,
): AsyncIterable<CliStreamFact> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* emitLine(backend, line);
      nl = buffer.indexOf("\n");
    }
  }
  yield* emitLine(backend, buffer);
}

function* emitLine(backend: CliBackend, line: string): Generator<CliStreamFact> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Non-JSON stdout noise — skip, never fatal.
    return;
  }
  yield* parseCliEvent(backend, value);
}
