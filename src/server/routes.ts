// Hono route definitions. Pure routing — module dependencies are passed in.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { ZodError } from "zod";
import type { Audit } from "../audit/index.ts";
import type { Capability } from "../capabilities/types.ts";
import { AgentNotFoundError } from "../catalog/index.ts";
import type { Agent, Catalog } from "../catalog/types.ts";
import type { Registry } from "../capabilities/index.ts";
import { CapabilityKind } from "../lib/capability-types.ts";
import { bearerAuth } from "./auth.ts";
import {
  type AgentDetailWire,
  type AgentSummaryWire,
  AuditQueryParams,
  BindingPatchBody,
  type CapabilityWire,
  type WireEvent,
} from "./types.ts";

export type RoutesDeps = {
  registry: Registry;
  catalog: Catalog;
  audit: Audit;
  token: string;
};

function toCapabilityWire(c: Capability): CapabilityWire {
  const tags = c.kind === "skill" || c.kind === "snippet" ? c.manifest.tags : undefined;
  const manifestSource =
    c.kind === "skill" || c.kind === "snippet" ? c.manifest.source : undefined;
  return {
    name: c.name,
    kind: c.kind,
    description: c.description,
    origin: c.origin,
    layer: c.layer,
    discovery: c.source,
    workplaceId: c.workplaceId,
    shadows: c.shadows?.map((s) => ({
      layer: s.layer,
      origin: s.origin,
      workplaceId: s.workplaceId,
    })),
    tags,
    upstream: manifestSource ? { url: manifestSource.url, ref: manifestSource.ref } : undefined,
  };
}

function toAgentSummary(a: Agent): AgentSummaryWire {
  return {
    agentId: a.agentId,
    backend: a.backend,
    domain: a.domain,
    layer: a.layer,
    hasFork: a.hasFork,
    bindingCounts: {
      skills: a.bindings.skills.length,
      snippets: a.bindings.snippets.length,
      tools: a.bindings.tools.length,
      mcp: a.bindings.mcp.length,
    },
  };
}

function toAgentDetail(a: Agent): AgentDetailWire {
  return {
    ...toAgentSummary(a),
    bindings: a.bindings,
    config: a.config,
    promptBody: a.promptBody,
    forkError: a.forkError,
  };
}

export function buildRoutes(deps: RoutesDeps): Hono {
  const app = new Hono();
  // Daemon listens on 127.0.0.1; CORS allowlist covers the two legitimate
  // callers: Electron renderer (file:// → Origin header "null") and the Vite
  // dev server. The bearer token is the real auth gate; this is defense in
  // depth so an arbitrary localhost origin can't even attempt a request.
  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "null",
  ]);
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      credentials: true,
    }),
  );
  app.use("/api/*", bearerAuth(deps.token));

  app.get("/api/ready", (c) => c.json({ status: "ok" }));

  app.get("/api/agents", (c) => {
    return c.json(deps.catalog.list().map(toAgentSummary));
  });

  app.get("/api/agents/:id", (c) => {
    const id = c.req.param("id");
    const agent = deps.catalog.get(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json(toAgentDetail(agent));
  });

  app.patch("/api/agents/:id/bindings", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = BindingPatchBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid binding patch", issues: zodIssues(parsed.error) },
        400,
      );
    }
    try {
      const updated = await deps.catalog.updateBindings(id, parsed.data.patches, "ui");
      return c.json(toAgentDetail(updated));
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  app.post("/api/agents/:id/reset", async (c) => {
    const id = c.req.param("id");
    try {
      const reset = await deps.catalog.resetToBundled(id);
      return c.json(toAgentDetail(reset));
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // Audit query — the durable answer to "what just happened" for any client
  // (ad-hoc curl, future hive-audit CLI, future UI). Same auth gate; same
  // redaction semantics (rows were redacted on write). Per ADR-0004.
  app.get("/api/audit", async (c) => {
    const parsed = AuditQueryParams.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: "invalid audit query", issues: zodIssues(parsed.error) },
        400,
      );
    }
    const rows = await deps.audit.query(parsed.data);
    return c.json(rows);
  });

  app.get("/api/capabilities", (c) => {
    const rawKind = c.req.query("kind");
    if (rawKind) {
      const parsed = CapabilityKind.safeParse(rawKind);
      if (!parsed.success) {
        return c.json({ error: "invalid kind" }, 400);
      }
      return c.json(
        deps.registry.list({ kind: parsed.data }).map(toCapabilityWire),
      );
    }
    return c.json(deps.registry.list().map(toCapabilityWire));
  });

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const disposers: Array<() => void> = [];

      // Per-listener try/catch: a single dead client must not propagate up
      // through TypedEmitter.emit and fail the originating mutation.
      const push = async (env: WireEvent): Promise<void> => {
        try {
          await stream.writeSSE({
            event: `${env.source}.${env.type}`,
            data: JSON.stringify(env),
          });
        } catch {
          // Stream closed or write failed; swallow. onAbort will trigger cleanup.
        }
      };

      try {
        disposers.push(
          deps.registry.events.on("capability.registered", (e) =>
            push({ source: "registry", type: "capability.registered", payload: e }),
          ),
        );
        disposers.push(
          deps.registry.events.on("capability.unregistered", (e) =>
            push({ source: "registry", type: "capability.unregistered", payload: e }),
          ),
        );
        disposers.push(
          deps.registry.events.on("capability.changed", (e) =>
            push({ source: "registry", type: "capability.changed", payload: e }),
          ),
        );
        disposers.push(
          deps.catalog.events.on("agent.created", (e) =>
            push({ source: "catalog", type: "agent.created", payload: e }),
          ),
        );
        disposers.push(
          deps.catalog.events.on("agent.destroyed", (e) =>
            push({ source: "catalog", type: "agent.destroyed", payload: e }),
          ),
        );
        disposers.push(
          deps.catalog.events.on("harness.updated", (e) =>
            push({ source: "catalog", type: "harness.updated", payload: e }),
          ),
        );

        // Open marker so the client knows the stream is live.
        await stream.writeSSE({ event: "ready", data: "{}" });

        // Block until client disconnects.
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        for (const d of disposers) d();
      }
    });
  });

  return app;
}

function zodIssues(err: ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
