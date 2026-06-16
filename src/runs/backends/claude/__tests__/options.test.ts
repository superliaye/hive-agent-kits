import { describe, expect, test } from "bun:test";
import { AgentId, RunId, ThreadId } from "../../../../lib/ids.ts";
import type { BackendInvocation } from "../../invocation.ts";
import { bareModelId, buildClaudeOptions } from "../options.ts";

function invocation(over: Partial<BackendInvocation> = {}): BackendInvocation {
  return {
    runId: RunId.parse(crypto.randomUUID()),
    threadId: ThreadId.parse(crypto.randomUUID()),
    agentId: AgentId.parse("worker"),
    backend: "claude-code",
    userMessage: [{ type: "text", text: "hi" }],
    history: [],
    systemPrompt: "you are helpful",
    cwd: "/work",
    model: "anthropic/claude-opus-4-1",
    provider: "anthropic",
    skills: [],
    mode: { kind: "create" },
    mcpEndpoint: "http://127.0.0.1:3117/mcp",
    signal: new AbortController().signal,
    ...over,
  };
}

describe("bareModelId", () => {
  test("strips the provider prefix", () => {
    expect(bareModelId("anthropic/claude-opus-4-1")).toBe("claude-opus-4-1");
  });
  test("passes a bare id through", () => {
    expect(bareModelId("claude-opus-4-1")).toBe("claude-opus-4-1");
  });
});

describe("buildClaudeOptions", () => {
  test("sets the bypass PAIR, partial messages, and the MCP server by URL", () => {
    const o = buildClaudeOptions({ invocation: invocation() });
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.includePartialMessages).toBe(true);
    expect(o.executable).toBe("bun");
    expect(o.mcpServers).toEqual({ hive: { type: "http", url: "http://127.0.0.1:3117/mcp" } });
    expect(o.allowedTools).toEqual(["mcp__hive__*"]);
    expect(o.settingSources).toEqual(["project"]);
    expect(o.skills).toBe("all");
  });

  test("forwards a bare --model only for the anthropic provider", () => {
    expect(buildClaudeOptions({ invocation: invocation({ provider: "anthropic" }) }).model).toBe(
      "claude-opus-4-1",
    );
    expect(
      buildClaudeOptions({ invocation: invocation({ provider: "openai-codex" }) }).model,
    ).toBeUndefined();
  });

  test("wires resume only on a resume invocation", () => {
    expect(buildClaudeOptions({ invocation: invocation() }).resume).toBeUndefined();
    expect(
      buildClaudeOptions({ invocation: invocation({ mode: { kind: "resume", sessionId: "s1" } }) })
        .resume,
    ).toBe("s1");
  });

  test("adds the plugins dir only when a projection path is given", () => {
    expect(buildClaudeOptions({ invocation: invocation() }).plugins).toBeUndefined();
    expect(buildClaudeOptions({ invocation: invocation(), pluginPath: "/p" }).plugins).toEqual([
      { type: "local", path: "/p" },
    ]);
  });

  test("spreads process.env and overlays an apiKey when present", () => {
    const o = buildClaudeOptions({
      invocation: invocation({ auth: { kind: "apiKey", apiKey: "sk-test" } }),
    });
    const env = o.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.PATH ?? env.Path).toBeDefined();
  });

  test("omits systemPrompt when blank", () => {
    expect(
      buildClaudeOptions({ invocation: invocation({ systemPrompt: "  " }) }).systemPrompt,
    ).toBeUndefined();
    expect(buildClaudeOptions({ invocation: invocation({ systemPrompt: "x" }) }).systemPrompt).toBe(
      "x",
    );
  });
});
