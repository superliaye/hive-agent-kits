import { describe, expect, test } from "bun:test";
import { type CliStreamFact, parseCliStream } from "../cli-stream.ts";

async function* fromChunks(chunks: readonly string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

async function collect(it: AsyncIterable<CliStreamFact>): Promise<CliStreamFact[]> {
  const out: CliStreamFact[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe("parseCliStream — claude-code", () => {
  test("captures session id from init + text from assistant events", async () => {
    const lines = [
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello " }] },
      })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "world" }] },
      })}\n`,
      `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
    ];
    const facts = await collect(parseCliStream("claude-code", fromChunks(lines)));
    expect(facts).toEqual([
      { kind: "session", sessionId: "sess-1" },
      { kind: "text", text: "hello " },
      { kind: "text", text: "world" },
    ]);
  });

  test("tolerates chunk boundaries mid-line", async () => {
    const json = JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });
    const half = json.slice(0, 10);
    const rest = `${json.slice(10)}\n`;
    const facts = await collect(parseCliStream("claude-code", fromChunks([half, rest])));
    expect(facts).toEqual([{ kind: "session", sessionId: "abc" }]);
  });

  test("ignores unknown event types and non-JSON noise (not fatal)", async () => {
    const lines = [
      "not json at all\n",
      `${JSON.stringify({ type: "stream_event", data: { foo: 1 } })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      })}\n`,
    ];
    const facts = await collect(parseCliStream("claude-code", fromChunks(lines)));
    expect(facts).toEqual([{ kind: "text", text: "ok" }]);
  });
});

// ─── P1.3 (Q3): tool_use → tool_result matching, observed tool facts ──────────
describe("parseCliStream — claude tool observation", () => {
  test("matches assistant tool_use to its user tool_result by tool_use_id (cross-message)", async () => {
    const lines = [
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
          ],
        },
      })}\n`,
      `${JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file.txt" }],
        },
      })}\n`,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      })}\n`,
      `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
    ];
    const facts = await collect(parseCliStream("claude-code", fromChunks(lines)));
    expect(facts).toEqual([
      { kind: "session", sessionId: "s1" },
      { kind: "text", text: "let me check" },
      { kind: "tool", tool: "Bash", isError: false },
      { kind: "text", text: "done" },
    ]);
  });

  test("an errored tool_result → tool fact with isError:true; a clean one → false", async () => {
    const lines = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu-ok", name: "Read", input: {} },
            { type: "tool_use", id: "tu-bad", name: "Bash", input: {} },
          ],
        },
      })}\n`,
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu-ok", content: "file" },
            { type: "tool_result", tool_use_id: "tu-bad", content: "boom", is_error: true },
          ],
        },
      })}\n`,
    ];
    const facts = await collect(parseCliStream("claude-code", fromChunks(lines)));
    const tools = facts.filter((f) => f.kind === "tool");
    expect(tools).toEqual([
      { kind: "tool", tool: "Read", isError: false },
      { kind: "tool", tool: "Bash", isError: true },
    ]);
  });

  test("a tool_use with NO matching tool_result emits no tool fact", async () => {
    const lines = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-9", name: "Edit", input: {} }],
        },
      })}\n`,
      // No matching user tool_result for tu-9.
      `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
    ];
    const facts = await collect(parseCliStream("claude-code", fromChunks(lines)));
    expect(facts.filter((f) => f.kind === "tool")).toEqual([]);
  });

  test("the observed fact carries the tool NAME only — no args/output (ADR-0004 refs)", async () => {
    const lines = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "SECRET" } }],
        },
      })}\n`,
      `${JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-2", content: "SECRET-OUTPUT" }],
        },
      })}\n`,
    ];
    const facts = await collect(parseCliStream("claude-code", fromChunks(lines)));
    const serialized = JSON.stringify(facts);
    expect(facts).toContainEqual({ kind: "tool", tool: "Bash", isError: false });
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("SECRET-OUTPUT");
  });
});

describe("parseCliStream — codex", () => {
  test("captures thread_id from thread.started + agent_message text", async () => {
    const lines = [
      `${JSON.stringify({ type: "thread.started", thread_id: "thr-9" })}\n`,
      `${JSON.stringify({ type: "turn.started" })}\n`,
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "answer" },
      })}\n`,
    ];
    const facts = await collect(parseCliStream("codex", fromChunks(lines)));
    expect(facts).toEqual([
      { kind: "session", sessionId: "thr-9" },
      { kind: "text", text: "answer" },
    ]);
  });

  test("ignores non-agent_message items", async () => {
    const lines = [
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "thinking..." },
      })}\n`,
    ];
    const facts = await collect(parseCliStream("codex", fromChunks(lines)));
    expect(facts).toEqual([]);
  });
});
