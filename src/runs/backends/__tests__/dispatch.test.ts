import { describe, expect, test } from "bun:test";
import { Stream } from "effect";
import { AgentId, RunId, ThreadId } from "../../../lib/ids.ts";
import type { RunEvent } from "../../types.ts";
import { type BackendAdapters, dispatch } from "../dispatch.ts";
import type { BackendInvocation } from "../invocation.ts";
import type { BackendRun } from "../port.ts";

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
    callbacks: { persistSession: () => {}, onToolObserved: () => {} },
  };
}

// A fake BackendRun tagged with which adapter ran, so dispatch routing is
// observable. (The real adapters spawn vendor SDKs — exercised live elsewhere.)
function tagged(tag: string): BackendRun {
  return {
    run: (inv) => {
      const completed: RunEvent = {
        type: "run.completed",
        runId: inv.runId,
        finishReason: "stop",
        finalMessage: {
          id: crypto.randomUUID(),
          threadId: inv.threadId,
          idx: 0,
          role: "assistant",
          content: [{ type: "text", text: tag }],
          createdAt: 1,
        },
        ts: 1,
      };
      return Stream.fromIterable([completed]) as ReturnType<BackendRun["run"]>;
    },
  };
}

async function collect(stream: ReturnType<BackendRun["run"]>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const a of Stream.toAsyncIterable(stream as Stream.Stream<RunEvent, never>))
    out.push(a);
  return out;
}

function textOf(events: RunEvent[]): string {
  const c = events.find((e) => e.type === "run.completed");
  if (c?.type !== "run.completed") return "";
  return c.finalMessage.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("backend dispatch", () => {
  const adapters: BackendAdapters = { "claude-code": tagged("claude"), codex: tagged("codex") };

  test("claude-code id routes to the Claude adapter", async () => {
    const events = await collect(dispatch(adapters, invocation("claude-code")));
    expect(events.map((e) => e.type)).toEqual(["run.completed"]);
    expect(textOf(events)).toBe("claude");
  });

  test("codex id routes to the Codex adapter", async () => {
    const events = await collect(dispatch(adapters, invocation("codex")));
    expect(events.map((e) => e.type)).toEqual(["run.completed"]);
    expect(textOf(events)).toBe("codex");
  });
});
