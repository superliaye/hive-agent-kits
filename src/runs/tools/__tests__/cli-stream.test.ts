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
