// Hono route definitions. Pure routing — module dependencies are passed in.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import type { Audit } from "../audit/index.ts";
import type { BackendProbeSvc, BackendUpdaterSvc } from "../backend-probe/index.ts";
import { BackendStatus, ProbeableBackend } from "../backend-probe/index.ts";
import type { BackendReadinessSvc } from "../backend-readiness/index.ts";
import { BackendReadiness } from "../backend-readiness/index.ts";
import { type AppConfig, AppearanceConfigSchema } from "../config/schema.ts";
import type { Config } from "../config/types.ts";
import type { Secrets } from "../secrets/index.ts";
import type { ConfiguredProvider } from "../secrets/types.ts";
import { bearerAuth } from "./auth.ts";
import { AuditQueryParams, type ConfiguredProviderWire, SetApiKeyBody } from "./types.ts";

export type RoutesDeps = {
  audit: Audit;
  secrets: Secrets;
  backendProbe: BackendProbeSvc;
  backendReadiness: BackendReadinessSvc;
  backendUpdater: BackendUpdaterSvc;
  config: Config<AppConfig>;
  token: string;
};

function toConfiguredProviderWire(p: ConfiguredProvider): ConfiguredProviderWire | undefined {
  // The Secrets `list()` never yields "missing"; defensive narrowing.
  if (p.status === "missing") return undefined;
  return {
    provider: p.provider,
    kind: p.kind,
    status: p.status,
    addedAt: p.addedAt,
    ...(p.refreshedAt !== undefined && { refreshedAt: p.refreshedAt }),
  };
}

export function buildRoutes(deps: RoutesDeps): Hono {
  const app = new Hono();

  // Daemon listens on 127.0.0.1; CORS allowlist covers the two legitimate
  // callers: Electron renderer (file:// → Origin header "null") and the Vite
  // dev server. The bearer token is the real auth gate; this is defense in
  // depth so an arbitrary localhost origin can't even attempt a request.
  const allowedOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "null"]);
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

  // On-demand backend availability probe (ADR-0016). Re-probes the CLI backends
  // and reports installed/missing + version with stable reason codes. Zod
  // guards the response shape at the boundary.
  app.get("/api/backends", async (c) => {
    const statuses = await deps.backendProbe.probeAll();
    return c.json(BackendStatus.array().parse(statuses));
  });

  // Backend Readiness projection (per-backend health ∩ provider auth state).
  // Read-only; feeds the Settings "Backends" page. Zod-validated at the boundary.
  app.get("/api/backends/readiness", async (c) => {
    const rows = await deps.backendReadiness.list();
    return c.json(BackendReadiness.array().parse(rows));
  });

  // Delegated CLI self-update (ADR-0016: Hive detects + delegates, never
  // installs/manages packages). Runs the backend's OWN updater, then re-probes
  // and returns the fresh BackendStatus. A self-update failure maps to a typed
  // JSON error; an unknown backend → 400.
  app.post("/api/backends/:backend/upgrade", async (c) => {
    const parsed = ProbeableBackend.safeParse(c.req.param("backend"));
    if (!parsed.success) {
      return c.json({ error: "unknown backend" }, 400);
    }
    const result = await deps.backendUpdater.upgrade(parsed.data);
    switch (result.kind) {
      case "ok":
        return c.json(BackendStatus.parse(result.status));
      case "spawn_failed":
        return c.json({ error: "updater not available", reason: "not_installed" }, 502);
      case "update_failed":
        return c.json({ error: "updater exited non-zero", reason: "update_failed" }, 502);
      case "timeout":
        return c.json({ error: "updater timed out", reason: "timeout" }, 502);
    }
  });

  // Audit query — the durable answer to "what just happened" for any client
  // (ad-hoc curl, future hive-audit CLI, future UI). Same auth gate; same
  // redaction semantics (rows were redacted on write). Per ADR-0004.
  app.get("/api/audit", async (c) => {
    const parsed = AuditQueryParams.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid audit query", issues: zodIssues(parsed.error) }, 400);
    }
    const rows = await deps.audit.query(parsed.data);
    return c.json(rows);
  });

  // ─── Secrets ─────────────────────────────────────────────────────────

  app.get("/api/secrets", (c) => {
    const out = deps.secrets
      .list()
      .map(toConfiguredProviderWire)
      .filter((w): w is ConfiguredProviderWire => w !== undefined);
    return c.json(out);
  });

  app.post("/api/secrets/:provider/api-key", async (c) => {
    const provider = c.req.param("provider");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = SetApiKeyBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: zodIssues(parsed.error) }, 400);
    }
    await deps.secrets.setApiKey(provider, parsed.data.apiKey);
    return c.body(null, 204);
  });

  app.delete("/api/secrets/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (deps.secrets.status(provider) === "missing") {
      return c.json({ error: "provider not configured" }, 404);
    }
    await deps.secrets.remove(provider);
    return c.body(null, 204);
  });

  // ─── Appearance (theme + font preferences) ───────────────────────────

  app.get("/api/appearance", (c) => {
    return c.json(deps.config.get("appearance"));
  });

  app.put("/api/appearance", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = AppearanceConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid appearance", issues: zodIssues(parsed.error) }, 400);
    }
    await deps.config.set("appearance", parsed.data);
    return c.json(parsed.data);
  });

  return app;
}

function zodIssues(err: ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
