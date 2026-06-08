// Hono route definitions. Pure routing — module dependencies are passed in.

import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { ZodError } from "zod";
import type { AgentModelPrefsSvc } from "../agent-prefs/index.ts";
import type { Audit } from "../audit/index.ts";
import type { Registry } from "../capabilities/index.ts";
import type { Capability } from "../capabilities/types.ts";
import { AgentNotFoundError } from "../catalog/index.ts";
import type { Agent, Catalog } from "../catalog/types.ts";
import { type AppConfig, AppearanceConfigSchema } from "../config/schema.ts";
import type { Config } from "../config/types.ts";
import { CapabilityKind } from "../lib/capability-types.ts";
import type { ModelGateway } from "../model-gateway/index.ts";
import type { RunExecutor } from "../runs/index.ts";
import type { Run } from "../runs/types.ts";
import type { Secrets } from "../secrets/index.ts";
import type { ConfiguredProvider } from "../secrets/types.ts";
import type { Threads } from "../threads/index.ts";
import type { Thread, ThreadMessage } from "../threads/types.ts";
import { bearerAuth } from "./auth.ts";
import {
  type AgentDetailWire,
  type AgentSummaryWire,
  AuditQueryParams,
  BindingPatchBody,
  type CapabilityWire,
  type ConfiguredProviderWire,
  CreateThreadBody,
  type OAuthProviderWire,
  type RunWire,
  SetAgentModelPrefBody,
  SetApiKeyBody,
  StartRunBody,
  type ThreadDetailWire,
  type ThreadSummaryWire,
  type WireEvent,
} from "./types.ts";

export type RoutesDeps = {
  registry: Registry;
  catalog: Catalog;
  audit: Audit;
  threads: Threads;
  runs: RunExecutor;
  secrets: Secrets;
  gateway: ModelGateway;
  agentModelPrefs: AgentModelPrefsSvc;
  config: Config<AppConfig>;
  token: string;
};

function toCapabilityWire(c: Capability): CapabilityWire {
  const tags = c.kind === "skill" || c.kind === "snippet" ? c.manifest.tags : undefined;
  const manifestSource = c.kind === "skill" || c.kind === "snippet" ? c.manifest.source : undefined;
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

function toThreadSummary(t: Thread): ThreadSummaryWire {
  return {
    id: t.id,
    agentId: t.agentId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function toThreadDetail(t: Thread, messages: ThreadMessage[]): ThreadDetailWire {
  return {
    ...toThreadSummary(t),
    messages: messages.map((m) => ({
      id: m.id,
      idx: m.idx,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  };
}

function toRunWire(r: Run): RunWire {
  return {
    id: r.id,
    threadId: r.threadId,
    agentId: r.agentId,
    model: r.model,
    status: r.status,
    startedAt: r.startedAt,
    ...(r.endedAt !== undefined && { endedAt: r.endedAt }),
    ...(r.finishReason !== undefined && { finishReason: r.finishReason }),
    ...(r.errorCode !== undefined && { errorCode: r.errorCode }),
    ...(r.errorMessage !== undefined && { errorMessage: r.errorMessage }),
  };
}

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

  // Single-flight guard for interactive OAuth logins. pi-ai's callback-server
  // providers each bind a *fixed* loopback port (openai-codex :1455,
  // anthropic :53692), so two concurrent logins can't both bind it — the
  // second silently fails to receive its callback and dies confusingly.
  // `oauthInFlight` is the in-flight provider id (for the rejection message);
  // `oauthOwner` is a per-request token so a stale login's cleanup can't free a
  // newer login's slot. Both cleared when the login settles or its SSE request
  // is aborted (UI cancel / navigation).
  let oauthInFlight: string | null = null;
  let oauthOwner: symbol | null = null;

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
      return c.json({ error: "invalid binding patch", issues: zodIssues(parsed.error) }, 400);
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

  // Per-agent model default (the user's sticky choice). `null` model means
  // unset — the executor then falls back to the Agent's harness config.model.
  app.get("/api/agents/:id/model-pref", (c) => {
    const id = c.req.param("id");
    if (!deps.catalog.get(id)) return c.json({ error: "agent not found" }, 404);
    return c.json({ model: deps.agentModelPrefs.get(id) ?? null });
  });

  app.put("/api/agents/:id/model-pref", async (c) => {
    const id = c.req.param("id");
    if (!deps.catalog.get(id)) return c.json({ error: "agent not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = SetAgentModelPrefBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: zodIssues(parsed.error) }, 400);
    }
    await deps.agentModelPrefs.set(id, parsed.data.model);
    return c.json({ model: parsed.data.model });
  });

  // Models the user can actually run: configured providers (have credentials)
  // ∩ routable providers (the gateway has an adapter). The picker's data source.
  // pi-ai stays imported only in its adapter — enumeration goes through the
  // gateway seam (ADR-0005).
  app.get("/api/models", (c) => {
    const models = deps.secrets.list().flatMap((p) => deps.gateway.listModels(p.provider));
    return c.json(models);
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

  app.get("/api/capabilities", (c) => {
    const rawKind = c.req.query("kind");
    if (rawKind) {
      const parsed = CapabilityKind.safeParse(rawKind);
      if (!parsed.success) {
        return c.json({ error: "invalid kind" }, 400);
      }
      return c.json(deps.registry.list({ kind: parsed.data }).map(toCapabilityWire));
    }
    return c.json(deps.registry.list().map(toCapabilityWire));
  });

  // ─── Threads ─────────────────────────────────────────────────────────

  app.get("/api/threads", (c) => {
    return c.json(deps.threads.list().map(toThreadSummary));
  });

  app.post("/api/threads", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = CreateThreadBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid thread body", issues: zodIssues(parsed.error) }, 400);
    }
    // Validate that the Agent exists at creation time — better error here
    // than at first startRun.
    const agent = deps.catalog.get(parsed.data.agentId);
    if (!agent) {
      return c.json({ error: `unknown agent: ${parsed.data.agentId}` }, 404);
    }
    const thread = deps.threads.create({ agentId: parsed.data.agentId });
    return c.json(toThreadSummary(thread), 201);
  });

  app.get("/api/threads/:id", (c) => {
    const id = c.req.param("id");
    const detail = deps.threads.getWithMessages(id);
    if (!detail) return c.json({ error: "thread not found" }, 404);
    return c.json(toThreadDetail(detail, detail.messages));
  });

  app.delete("/api/threads/:id", (c) => {
    const id = c.req.param("id");
    if (!deps.threads.get(id)) return c.json({ error: "thread not found" }, 404);
    deps.threads.remove(id);
    return c.body(null, 204);
  });

  app.get("/api/threads/:id/runs", (c) => {
    const id = c.req.param("id");
    if (!deps.threads.get(id)) return c.json({ error: "thread not found" }, 404);
    return c.json(deps.runs.listByThread(id).map(toRunWire));
  });

  // Start a Run. Returns Server-Sent Events: one SSE message per RunEvent.
  // Event names match the RunEvent.type discriminator (`run.started`,
  // `model.event`, `run.completed`, `run.failed`, `run.cancelled`). Data is
  // the JSON-encoded RunEvent. Connection closes after the terminal event.
  app.post("/api/threads/:id/runs", async (c) => {
    const threadId = c.req.param("id");
    if (!deps.threads.get(threadId)) {
      return c.json({ error: "thread not found" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = StartRunBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid run body", issues: zodIssues(parsed.error) }, 400);
    }
    // Defensive: catch the synchronous-throw concurrency check before we
    // open the SSE stream. A 409 is more useful to clients than a stream
    // that immediately errors.
    let runIterable: AsyncIterable<unknown>;
    try {
      runIterable = deps.runs.startRun({
        threadId,
        userMessage: parsed.data.userMessage,
        ...(parsed.data.modelOverride !== undefined && {
          modelOverride: parsed.data.modelOverride,
        }),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("already in flight")) {
        return c.json({ error: msg }, 409);
      }
      if (msg.includes("thread not found")) {
        return c.json({ error: msg }, 404);
      }
      throw err;
    }
    return streamSSE(c, async (stream) => {
      try {
        for await (const ev of runIterable as AsyncIterable<{ type: string }>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch {
        // Stream client disconnected mid-Run; iterable will continue in the
        // background and persist results normally.
      }
    });
  });

  // ─── Runs ─────────────────────────────────────────────────────────────

  app.get("/api/runs/:id", (c) => {
    const r = deps.runs.getRun(c.req.param("id"));
    if (!r) return c.json({ error: "run not found" }, 404);
    return c.json(toRunWire(r));
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    if (!deps.runs.getRun(id)) return c.json({ error: "run not found" }, 404);
    deps.runs.cancelRun(id);
    return c.body(null, 202);
  });

  // ─── Secrets ─────────────────────────────────────────────────────────

  app.get("/api/secrets", (c) => {
    const out = deps.secrets
      .list()
      .map(toConfiguredProviderWire)
      .filter((w): w is ConfiguredProviderWire => w !== undefined);
    return c.json(out);
  });

  // Available OAuth providers from pi-ai's registry. UI shows these as
  // "Log in with X" actions in Settings. Filtered to providers Hive's
  // pi-ai adapter actually routes to (so we don't offer login to a
  // provider we couldn't then use).
  app.get("/api/secrets/oauth-providers", (c) => {
    const providers = getOAuthProviders().map<OAuthProviderWire>((p) => ({
      id: p.id,
      name: p.name,
    }));
    return c.json(providers);
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

  // Start an OAuth login. Returns Server-Sent Events; pi-ai's login flow
  // signals progress and asks for the auth URL to be opened via the
  // `onAuth` callback. v1 only supports the callback-server flow (no
  // interactive prompts over HTTP); providers that require manual code
  // input fail with a clear error.
  //
  // Event names:
  //   - `auth`     — { url, instructions? }    open this URL in a browser
  //   - `progress` — { message }              optional info
  //   - `done`     — { provider }             credentials stored
  //   - `error`    — { message }              login failed
  app.post("/api/secrets/:provider/oauth/login", async (c) => {
    const provider = c.req.param("provider");
    // `usesCallbackServer` providers fail by losing the browser callback (busy
    // port), not by needing a prompt — so onPrompt being hit means something
    // else; give an actionable message instead of "prompt not supported".
    const usesCallbackServer =
      getOAuthProviders().find((p) => p.id === provider)?.usesCallbackServer ?? false;
    return streamSSE(c, async (stream) => {
      if (oauthInFlight) {
        const msg = `a sign-in for "${oauthInFlight}" is already in progress — finish it in your browser or cancel it, then try again`;
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: msg }) });
        return;
      }
      const owner = Symbol("oauth-login");
      oauthInFlight = provider;
      oauthOwner = owner;
      const release = () => {
        if (oauthOwner === owner) {
          oauthInFlight = null;
          oauthOwner = null;
        }
      };
      // Free the slot if the client disconnects (UI cancel / navigation). The
      // dangling pi-ai callback server can't be torn down until the next daemon
      // restart, but releasing the slot lets the user retry (and get the clear
      // "port busy" message above rather than a silent block).
      stream.onAbort(release);
      try {
        await deps.secrets.startOAuthLogin(provider, {
          onAuth: (info) => {
            // pi-ai's onAuth is synchronous; fire-and-forget the SSE write.
            // Order is preserved by the underlying stream. Drop on failure
            // (dead client) — the catch keeps the promise from floating.
            stream
              .writeSSE({
                event: "auth",
                data: JSON.stringify({
                  url: info.url,
                  ...(info.instructions !== undefined && { instructions: info.instructions }),
                }),
              })
              .catch(() => {});
          },
          onProgress: (message) => {
            stream
              .writeSSE({ event: "progress", data: JSON.stringify({ message }) })
              .catch(() => {});
          },
          // v1 supports only the loopback callback-server flow over HTTP.
          // onPrompt/onSelect are genuine interactive steps a provider may
          // demand mid-flow (e.g. GitHub Copilot's enterprise-URL prompt);
          // surface a clear error and bail when one is hit.
          //
          // Deliberately NO onManualCodeInput: pi-ai's callback-server
          // providers (anthropic, openai-codex) *race* a supplied
          // onManualCodeInput against the browser callback, so a rejecting
          // stub cancels the wait and tears down the loopback server on
          // :1455 before the user finishes authenticating. Omitting it lets
          // the loopback server receive the redirect and win normally.
          onPrompt: async () => {
            const msg = usesCallbackServer
              ? "couldn't complete the browser sign-in — the callback port may be in use by another sign-in or the Codex CLI. Restart Hive and try again."
              : "interactive prompt not yet supported over HTTP; OAuth provider requires manual input";
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: msg }) });
            throw new Error(msg);
          },
          onSelect: async () => {
            const msg = "interactive selection not yet supported over HTTP";
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: msg }) });
            throw new Error(msg);
          },
        });
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ provider }),
        });
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: (err as Error).message }),
        });
      } finally {
        release();
      }
    });
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

  // ─── Module event stream ─────────────────────────────────────────────

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
