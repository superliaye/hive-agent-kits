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
// persistence; `tool` is recorded as an OBSERVED-after-the-fact audit event (the
// tool NAME, a ref — never args/output; the CLI owns the gate, P1.2/P1.3 Q3). An
// unmodeled event yields nothing (parsed → no fact).
export type CliStreamFact =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string };

// ─── claude-code stream-json ──────────────────────────────────────────────────

const claudeInit = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
});

// Assistant content blocks: `text` carries assistant output; `tool_use` carries
// a tool call (id + name + input) the CLI is about to run. We model only the
// fields we read (text, the tool_use id/name) and ignore the rest.
const claudeAssistant = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
      }),
    ),
  }),
});

// User content blocks carry the `tool_result` for an earlier `tool_use`, keyed
// by `tool_use_id`. We read only the id (the match key) — never the result
// content (ADR-0004: refs not values).
const claudeUser = z.object({
  type: z.literal("user"),
  message: z.object({
    content: z.array(z.object({ type: z.string(), tool_use_id: z.string().optional() })),
  }),
});

// claude's tool calls span two messages: the `assistant`→`tool_use` block names
// the tool (recorded in `pending` by id), and a later `user`→`tool_result` block
// confirms it RAN (matched by `tool_use_id`). We emit the OBSERVED tool fact at
// the result — proof the CLI executed it — carrying the tool NAME only (a ref).
// `pending` (tool_use_id → name) is owned by `parseCliStream` and threaded here.
function parseClaudeEvent(value: unknown, pending: Map<string, string>): CliStreamFact[] {
  const init = claudeInit.safeParse(value);
  if (init.success) return [{ kind: "session", sessionId: init.data.session_id }];

  const asst = claudeAssistant.safeParse(value);
  if (asst.success) {
    const facts: CliStreamFact[] = [];
    for (const b of asst.data.message.content) {
      if (b.type === "text" && b.text !== undefined) {
        facts.push({ kind: "text", text: b.text });
      } else if (b.type === "tool_use" && b.id !== undefined && b.name !== undefined) {
        pending.set(b.id, b.name);
      }
    }
    return facts;
  }

  const user = claudeUser.safeParse(value);
  if (user.success) {
    const facts: CliStreamFact[] = [];
    for (const b of user.data.message.content) {
      if (b.type !== "tool_result" || b.tool_use_id === undefined) continue;
      const name = pending.get(b.tool_use_id);
      if (name !== undefined) {
        pending.delete(b.tool_use_id);
        facts.push({ kind: "tool", tool: name });
      }
    }
    return facts;
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
// JSON-parses but matches no modeled shape yields []. `pending` carries the
// cross-message tool_use→tool_result match state (claude only; codex's tool
// shape is paper-only in v1). Exported for unit testing; callers that don't need
// tool observation pass a throwaway map.
export function parseCliEvent(
  backend: CliBackend,
  value: unknown,
  pending: Map<string, string> = new Map(),
): CliStreamFact[] {
  return backend === "claude-code" ? parseClaudeEvent(value, pending) : parseCodexEvent(value);
}

// Line-buffer + JSON.parse + normalize a raw stdout chunk stream into a flat
// stream of facts. Malformed (non-JSON) lines are skipped (a CLI may interleave
// non-JSONL noise on stdout); a partial trailing line is held until its newline
// arrives, then flushed at stream end.
export async function* parseCliStream(
  backend: CliBackend,
  chunks: AsyncIterable<string>,
): AsyncIterable<CliStreamFact> {
  // Cross-message tool_use→tool_result match state (claude). Lives for the whole
  // stream so a `tool_use` in one assistant message matches its `tool_result` in
  // a later user message.
  const pending = new Map<string, string>();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* emitLine(backend, line, pending);
      nl = buffer.indexOf("\n");
    }
  }
  yield* emitLine(backend, buffer, pending);
}

function* emitLine(
  backend: CliBackend,
  line: string,
  pending: Map<string, string>,
): Generator<CliStreamFact> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Non-JSON stdout noise — skip, never fatal.
    return;
  }
  yield* parseCliEvent(backend, value, pending);
}
