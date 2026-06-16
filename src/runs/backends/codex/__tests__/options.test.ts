import { describe, expect, test } from "bun:test";
import { AgentId, RunId, ThreadId } from "../../../../lib/ids.ts";
import type { BackendInvocation } from "../../invocation.ts";
import { bareModelId, buildCodexOptions, codexReasoningEffort } from "../options.ts";

function invocation(over: Partial<BackendInvocation> = {}): BackendInvocation {
  return {
    runId: RunId.parse(crypto.randomUUID()),
    threadId: ThreadId.parse(crypto.randomUUID()),
    agentId: AgentId.parse("worker"),
    backend: "codex",
    userMessage: [{ type: "text", text: "hi" }],
    history: [],
    systemPrompt: "you are helpful",
    cwd: "/work",
    model: "openai-codex/gpt-5-codex",
    provider: "openai-codex",
    skills: [],
    mode: { kind: "create" },
    mcpEndpoint: "http://127.0.0.1:3117/mcp",
    signal: new AbortController().signal,
    ...over,
  };
}

describe("codexReasoningEffort", () => {
  test("maps Hive efforts onto Codex's set; off has no equivalent", () => {
    expect(codexReasoningEffort("off")).toBeUndefined();
    expect(codexReasoningEffort("minimal")).toBe("minimal");
    expect(codexReasoningEffort("low")).toBe("low");
    expect(codexReasoningEffort("medium")).toBe("medium");
    expect(codexReasoningEffort("high")).toBe("high");
    expect(codexReasoningEffort("xhigh")).toBe("xhigh");
  });
});

describe("bareModelId", () => {
  test("strips the provider prefix", () => {
    expect(bareModelId("openai-codex/gpt-5-codex")).toBe("gpt-5-codex");
  });
});

describe("buildCodexOptions", () => {
  test("governance: approvalPolicy never + sandbox workspace-write + skipGitRepoCheck", () => {
    const { thread } = buildCodexOptions(invocation());
    expect(thread.approvalPolicy).toBe("never");
    expect(thread.sandboxMode).toBe("workspace-write");
    expect(thread.skipGitRepoCheck).toBe(true);
    expect(thread.workingDirectory).toBe("/work");
    expect(thread.model).toBe("gpt-5-codex");
  });

  test("wires the Hive MCP server via config.mcp_servers by URL", () => {
    const { codex } = buildCodexOptions(invocation());
    expect(codex.config?.mcp_servers).toEqual({
      hive: { url: "http://127.0.0.1:3117/mcp" },
    });
  });

  test("carries the instruction blob via config.developer_instructions when non-empty", () => {
    expect(buildCodexOptions(invocation()).codex.config?.developer_instructions).toBe(
      "you are helpful",
    );
    expect(
      buildCodexOptions(invocation({ systemPrompt: "  " })).codex.config?.developer_instructions,
    ).toBeUndefined();
  });

  test("forwards apiKey auth onto the Codex client", () => {
    expect(
      buildCodexOptions(invocation({ auth: { kind: "apiKey", apiKey: "sk-x" } })).codex.apiKey,
    ).toBe("sk-x");
    expect(buildCodexOptions(invocation()).codex.apiKey).toBeUndefined();
  });

  test("maps effort onto modelReasoningEffort; omits it for off/undefined", () => {
    expect(buildCodexOptions(invocation({ effort: "high" })).thread.modelReasoningEffort).toBe(
      "high",
    );
    expect(
      buildCodexOptions(invocation({ effort: "off" })).thread.modelReasoningEffort,
    ).toBeUndefined();
    expect(buildCodexOptions(invocation()).thread.modelReasoningEffort).toBeUndefined();
  });
});
