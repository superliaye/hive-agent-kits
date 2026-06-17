import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type AgentLifecyclePort,
  type CapabilityInvokePort,
  createCapabilityMcpServer,
} from "../capabilities-mcp.ts";

// A fake capability registry + agent lifecycle, recording calls so the test can
// assert the MCP request reached the port.
const invoked: Array<{ name: string; args: unknown }> = [];
const lifecycle: string[] = [];

const capabilities: CapabilityInvokePort = {
  invoke: async (name, args) => {
    invoked.push({ name, args });
    return { content: JSON.stringify({ echoed: name }), isError: false };
  },
};
const agents: AgentLifecyclePort = {
  createAgent: async ({ agentId }) => {
    lifecycle.push(`create:${agentId}`);
    return { agentId };
  },
  updateAgentHarness: async ({ agentId }) => {
    lifecycle.push(`update:${agentId}`);
    return { agentId };
  },
  destroyAgent: async ({ agentId }) => {
    lifecycle.push(`destroy:${agentId}`);
  },
};

let httpServer: ReturnType<typeof Bun.serve>;
let base: string;
const mcp = createCapabilityMcpServer({ capabilities, agents });

async function connectClient(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base)));
  return client;
}

beforeAll(() => {
  httpServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") return mcp.handle(req);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${httpServer.port}/mcp`;
});

afterAll(async () => {
  await mcp.dispose();
  httpServer.stop(true);
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("capability MCP server (both backends connect by URL)", () => {
  test("lists the Hive domain tools — and NO file/shell/skill tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_agent",
      "destroy_agent",
      "invoke_capability",
      "memory_read",
      "update_agent_harness",
    ]);
    await client.close();
  });

  test("memory_read is invocable and returns the stub's canned/empty result", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "memory_read", arguments: { key: "k" } });
    const parsed = JSON.parse(textOf(res as { content: Array<{ type: string; text?: string }> }));
    expect(parsed).toMatchObject({ key: "k", value: null, found: false, stub: true });
    await client.close();
  });

  test("invoke_capability routes through the registry port", async () => {
    const client = await connectClient();
    await client.callTool({
      name: "invoke_capability",
      arguments: { name: "weather", args: { city: "x" } },
    });
    expect(invoked.at(-1)).toEqual({ name: "weather", args: { city: "x" } });
    await client.close();
  });

  test("the AM lifecycle tools route through the lifecycle port", async () => {
    const client = await connectClient();
    await client.callTool({
      name: "create_agent",
      arguments: {
        agentId: "writer",
        backend: "claude-code",
        domain: "writing",
        promptBody: "you write",
      },
    });
    await client.callTool({
      name: "update_agent_harness",
      arguments: {
        agentId: "writer",
        bindings: [{ kind: "skill", name: "compose", action: "bind" }],
      },
    });
    await client.callTool({ name: "destroy_agent", arguments: { agentId: "writer" } });
    expect(lifecycle).toEqual(["create:writer", "update:writer", "destroy:writer"]);
    await client.close();
  });
});
