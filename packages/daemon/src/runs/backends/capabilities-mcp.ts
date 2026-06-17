// The ONE Hive capability MCP server (spec §unified MCP surface). Codex accepts
// only MCP servers (config.mcp_servers); Claude accepts MCP servers too — so MCP
// is the common denominator, the single "author tools once" boundary both
// backends consume by URL. Served over the existing Hono daemon (local HTTP);
// see `server/index.ts` for the mount.
//
// It exposes Hive DOMAIN tools ONLY — Memory (a non-functional STUB this
// iteration, Q-mcp-scope), capability invocation, and the Agent-Manager
// lifecycle tools. It NEVER re-exposes file/shell (each SDK brings its own) and
// NEVER carries skills (skills are SDK-native; MCP is for tools).
//
// Zod at the request/response boundary (AGENTS.md): every tool's inputSchema is
// a Zod shape the MCP SDK validates before the handler runs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AgentBackend } from "../../lib/capability-types.ts";
import { log } from "../../lib/log.ts";

// Narrow, consumer-owned ports the capability tools call. The composition root
// adapts the real Catalog + Registry to these shapes — the MCP server never
// imports catalog/capabilities concretes (AGENTS.md ports-and-adapters).

export type CapabilityInvokePort = {
  /** Invoke a bound capability tool by name with JSON args. */
  invoke(name: string, args: unknown): Promise<{ content: string; isError: boolean }>;
};

export type AgentLifecyclePort = {
  createAgent(input: {
    agentId: string;
    backend: AgentBackend;
    domain: string;
    promptBody: string;
  }): Promise<{ agentId: string }>;
  updateAgentHarness(input: {
    agentId: string;
    bindings: Array<{
      kind: "skill" | "snippet" | "tool" | "mcp";
      name: string;
      action: "bind" | "unbind";
    }>;
  }): Promise<{ agentId: string }>;
  destroyAgent(input: { agentId: string }): Promise<void>;
};

export type CapabilityMcpDeps = {
  capabilities: CapabilityInvokePort;
  agents: AgentLifecyclePort;
};

// The MCP server's public name — both SDKs reference tools as `mcp__<server>__*`.
export const CAPABILITY_MCP_SERVER_NAME = "hive";

const AgentBackendSchema = z.enum(["claude-code", "codex"]);

// Build a fresh McpServer instance with all Hive capability tools registered.
// One instance per transport/session (the MCP SDK couples a server to one
// transport); the deps are shared singletons captured by closure.
export function buildCapabilityMcpServer(deps: CapabilityMcpDeps): McpServer {
  const server = new McpServer({ name: CAPABILITY_MCP_SERVER_NAME, version: "1.0.0" });

  // Memory tool — NON-FUNCTIONAL STUB (Q-mcp-scope BINDING). Registered and
  // invocable via MCP from BOTH backends to prove the end-to-end seam; returns
  // canned/empty data with NO persistent store. The full Memory subsystem is an
  // explicit follow-up, out of scope here.
  server.registerTool(
    "memory_read",
    {
      description:
        "Read from the agent's Memory by key. (Stub: returns an empty result — the persistent Memory store is a follow-up.)",
      inputSchema: { key: z.string().describe("The memory key to read.") },
    },
    async ({ key }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ key, value: null, found: false, stub: true }),
        },
      ],
    }),
  );

  // Capability invocation — the generic "author tools once" boundary: invoke a
  // bound Capability from the Registry.
  server.registerTool(
    "invoke_capability",
    {
      description:
        "Invoke a bound Hive capability tool by name with JSON arguments. NOTE: cannot execute capabilities yet — there is no in-process tool runtime, so a found capability returns an error until that runtime lands.",
      inputSchema: {
        name: z.string().describe("The bound capability tool name."),
        args: z.unknown().optional().describe("JSON arguments for the capability."),
      },
    },
    async ({ name, args }) => {
      const result = await deps.capabilities.invoke(name, args);
      return {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      };
    },
  );

  // Agent-Manager lifecycle tools (Q-mcp-scope + Q-am-lock BINDING). These MCP
  // tools are the AM's only path to perform lifecycle ops (ADR-0019).
  server.registerTool(
    "create_agent",
    {
      description: "Create a new Hive agent with a fresh runtime HARNESS.md.",
      inputSchema: {
        agentId: z.string().describe("kebab-case agent id."),
        backend: AgentBackendSchema.describe("The agent's execution backend."),
        domain: z.string().describe("Short domain/role description."),
        promptBody: z.string().describe("The agent's authored system-prompt body."),
      },
    },
    async ({ agentId, backend, domain, promptBody }) => {
      const created = await deps.agents.createAgent({ agentId, backend, domain, promptBody });
      return { content: [{ type: "text", text: JSON.stringify({ created: created.agentId }) }] };
    },
  );

  server.registerTool(
    "update_agent_harness",
    {
      description: "Bind or unbind capabilities on an existing agent's harness.",
      inputSchema: {
        agentId: z.string().describe("The agent to update."),
        bindings: z
          .array(
            z.object({
              kind: z.enum(["skill", "snippet", "tool", "mcp"]),
              name: z.string(),
              action: z.enum(["bind", "unbind"]),
            }),
          )
          .min(1)
          .describe("One or more binding mutations to apply."),
      },
    },
    async ({ agentId, bindings }) => {
      const updated = await deps.agents.updateAgentHarness({ agentId, bindings });
      return { content: [{ type: "text", text: JSON.stringify({ updated: updated.agentId }) }] };
    },
  );

  server.registerTool(
    "destroy_agent",
    {
      description: "Destroy a runtime agent (deletes its runtime HARNESS.md).",
      inputSchema: { agentId: z.string().describe("The agent to destroy.") },
    },
    async ({ agentId }) => {
      await deps.agents.destroyAgent({ agentId });
      return { content: [{ type: "text", text: JSON.stringify({ destroyed: agentId }) }] };
    },
  );

  return server;
}

// A mounted capability MCP server: a Hono-compatible request handler + a
// disposer. Stateful sessions (the documented MCP HTTP mode): an `initialize`
// POST spins up a fresh transport+server, keyed by the generated session id;
// subsequent requests route by the `mcp-session-id` header.
export type CapabilityMcpHandle = {
  /** Handle one MCP HTTP request (GET/POST/DELETE) — wire to a Hono `app.all`. */
  handle(req: Request): Promise<Response>;
  /** Close all open sessions. */
  dispose(): Promise<void>;
};

export function createCapabilityMcpServer(deps: CapabilityMcpDeps): CapabilityMcpHandle {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  async function handle(req: Request): Promise<Response> {
    try {
      const sid = req.headers.get("mcp-session-id") ?? undefined;
      const existing = sid ? transports.get(sid) : undefined;
      if (existing) return await existing.handleRequest(req);

      if (req.method === "POST") {
        const parsed: unknown = await req.json().catch(() => undefined);
        if (parsed !== undefined && isInitializeRequest(parsed)) {
          const transport: WebStandardStreamableHTTPServerTransport =
            new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (id) => {
                transports.set(id, transport);
              },
              onsessionclosed: (id) => {
                transports.delete(id);
              },
            });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await buildCapabilityMcpServer(deps).connect(transport);
          return await transport.handleRequest(req, { parsedBody: parsed });
        }
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session id" },
          id: null,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    } catch (err) {
      log().error({ module: "runs/capabilities-mcp", err }, "MCP request failed");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  async function dispose(): Promise<void> {
    for (const transport of transports.values()) {
      await transport.close().catch(() => {});
    }
    transports.clear();
  }

  return { handle, dispose };
}
