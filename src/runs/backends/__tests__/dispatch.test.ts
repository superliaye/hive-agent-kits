import { describe, expect, test } from "bun:test";
import { Stream } from "effect";
import { AgentId, RunId, ThreadId } from "../../../lib/ids.ts";
import { createClaudeAdapter } from "../claude/adapter.ts";
import { createCodexAdapter } from "../codex/adapter.ts";
import { dispatch } from "../dispatch.ts";
import type { BackendInvocation } from "../invocation.ts";

function invocation(backend: "claude-code" | "codex"): BackendInvocation {
  return {
    runId: RunId.parse(crypto.randomUUID()),
    threadId: ThreadId.parse(crypto.randomUUID()),
    agentId: AgentId.parse("worker"),
    backend,
    userMessage: [{ type: "text", text: "hi" }],
    history: [],
    systemPrompt: "",
    cwd: "/tmp",
    model: "anthropic/claude-opus",
    provider: "anthropic",
    skills: [],
    mode: { kind: "create" },
    mcpEndpoint: "http://127.0.0.1:3117/mcp",
    signal: new AbortController().signal,
  };
}

describe("backend dispatch", () => {
  const adapters = {
    "claude-code": createClaudeAdapter({ now: () => 1 }),
    codex: createCodexAdapter({ now: () => 1 }),
  };

  test("claude-code id routes to the Claude adapter and yields run.completed", async () => {
    const events = await collect(dispatch(adapters, invocation("claude-code")));
    expect(events.map((e) => e.type)).toEqual(["run.completed"]);
  });

  test("codex id routes to the Codex adapter and yields run.completed", async () => {
    const events = await collect(dispatch(adapters, invocation("codex")));
    expect(events.map((e) => e.type)).toEqual(["run.completed"]);
  });

  test("the routed completion carries the dispatched backend's stub text", async () => {
    const claude = await collect(dispatch(adapters, invocation("claude-code")));
    const codex = await collect(dispatch(adapters, invocation("codex")));
    const claudeText = textOf(claude);
    const codexText = textOf(codex);
    expect(claudeText).toContain("claude");
    expect(codexText).toContain("codex");
  });
});

async function collect<A>(stream: Stream.Stream<A, unknown>): Promise<A[]> {
  const out: A[] = [];
  for await (const a of Stream.toAsyncIterable(stream as Stream.Stream<A, never>)) out.push(a);
  return out;
}

function textOf(events: Array<{ type: string }>): string {
  const completed = events.find((e) => e.type === "run.completed") as
    | { finalMessage: { content: Array<{ type: string; text?: string }> } }
    | undefined;
  return (
    completed?.finalMessage.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? ""
  );
}
