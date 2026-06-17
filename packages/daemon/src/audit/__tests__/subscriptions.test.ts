/**
 * Integration tests for wireSubscriptions — the cross-module seam that
 * attaches emitter modules to the audit log.
 *
 * Audit covers user/agent-driven side effects (ADR-0004 "Audit vs trace"
 * amendment). System-driven scan/lifecycle events flow through the trace
 * log, not audit — verified here by asserting their absence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ManagedRuntime, Stream } from "effect";
import { z } from "zod";
import { createRegistry } from "../../capabilities/index.ts";
import type { Capability } from "../../capabilities/types.ts";
import { CatalogLive, Catalog as CatalogTag } from "../../catalog/effect/catalog-live.ts";
import type { Agent } from "../../catalog/types.ts";
import { configRuntime } from "../../config/effect/config-live.ts";
import { openHiveDb } from "../../db/hive-db.ts";
import { AgentId } from "../../lib/ids.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import type { BackendInvocation } from "../../runs/backends/invocation.ts";
import type { BackendRun } from "../../runs/backends/port.ts";
import { createRunExecutor } from "../../runs/executor.ts";
import { createRunsStore } from "../../runs/store.ts";
import type { RunEvent } from "../../runs/types.ts";
import {
  SecretsLive,
  type SecretsSvc,
  Secrets as SecretsTag,
} from "../../secrets/effect/secrets-live.ts";
import { createThreadsStore } from "../../threads/store.ts";
import { AuditLive, type AuditSvc, Audit as AuditTag } from "../effect/audit-live.ts";
import { wireSubscriptions } from "../subscriptions.ts";

// Runtimes resolved across this file's tests; disposed in afterEach.
const runtimes: Array<{ dispose(): Promise<void> }> = [];
function makeSecrets(): SecretsSvc {
  const runtime = ManagedRuntime.make(SecretsLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(SecretsTag);
}
function makeAudit(): AuditSvc {
  const runtime = ManagedRuntime.make(AuditLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(AuditTag);
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.dispose();
});

// A fake BackendRun for the run-source + backend-source audit tests: yields a
// scripted RunEvent sequence and exercises the executor's audit emitters.
function fakeBackend(script: (inv: BackendInvocation) => RunEvent[]): BackendRun {
  return {
    run: (inv) => Stream.fromIterable(script(inv)) as ReturnType<BackendRun["run"]>,
  };
}

describe("wireSubscriptions", () => {
  test("config.set produces a config.change audit row", async () => {
    const audit = makeAudit();
    const schema = z.object({ theme: z.string() });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { theme: "light" },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });

    await config.set("theme", "dark");

    const rows = await audit.query({ source: "config" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("config.change");
    expect(rows[0]?.payload).toMatchObject({
      key: "theme",
      previous: "light",
      current: "dark",
      source: "set",
    });

    dispose();
    disposeConfig();
  });

  // Privacy redaction: the audit subscriber must strip color hex out of
  // `appearance` change payloads (mode-picker is fine, accent / overrides
  // are personal taste). Documented in audit/subscriptions.ts.
  test("appearance config.change records only the mode, never color hex", async () => {
    const audit = makeAudit();
    const schema = z.object({
      appearance: z.object({
        mode: z.enum(["light", "dark", "system"]),
        dark: z.object({ accent: z.string().optional() }).optional(),
      }),
    });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { appearance: { mode: "system" } },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });

    await config.set("appearance", {
      mode: "dark",
      dark: { accent: "#deadbeef" },
    });

    const rows = await audit.query({ source: "config" });
    expect(rows.length).toBe(1);
    const payload = rows[0]?.payload as { key: string; previous: unknown; current: unknown };
    expect(payload.key).toBe("appearance");
    expect(payload.previous).toEqual({ mode: "system" });
    expect(payload.current).toEqual({ mode: "dark" });
    // Defense-in-depth: the literal hex must not appear anywhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain("deadbeef");

    dispose();
    disposeConfig();
  });

  test("registry.start() is NOT audited; scan-time events are trace-only", async () => {
    const audit = makeAudit();
    const fakeCap: Capability = {
      kind: "skill",
      name: "foo",
      description: "test skill",
      origin: "personal",
      source: "filesystem",
      layer: "bundled",
      path: "/fake/foo/SKILL.md",
      manifest: { name: "foo", description: "test skill" },
      body: "",
    };
    const registry = createRegistry({
      scanner: () => ({ capabilities: [fakeCap], errors: [] }),
      watch: false,
      logErrors: false,
    });
    const dispose = wireSubscriptions(audit, { registry });

    await registry.start();

    const rows = await audit.query({ source: "registry" });
    expect(rows.length).toBe(0);
    dispose();
    registry.dispose();
  });

  test("catalog.start() (scan) is NOT audited; only user/agent actions are", async () => {
    const audit = makeAudit();
    const fakeAgent: Agent = {
      agentId: AgentId.parse("root"),
      backend: "claude-code",
      domain: "orchestration",
      bindings: { skills: [], snippets: [], tools: [], mcp: [] },
      config: {},
      promptBody: "",
      layer: "bundled",
      hasFork: false,
      path: "/fake/bundled/agents/root/HARNESS.md",
    };
    const catalogRuntime = ManagedRuntime.make(
      CatalogLive({ scanner: () => ({ agents: [fakeAgent], errors: [] }), logErrors: false }),
    );
    try {
      const catalog = catalogRuntime.runSync(CatalogTag);
      const dispose = wireSubscriptions(audit, { catalog });

      await catalog.start();

      // Scan-time agent.created should NOT appear in audit.
      const rows = await audit.query({ source: "catalog" });
      expect(rows.length).toBe(0);

      dispose();
    } finally {
      await catalogRuntime.dispose();
    }
  });

  // Secrets is user/agent-driven, so its mutating verbs ARE audited. The
  // verbs are async + block-on-failure (4.2-A1): a write produces a row, and
  // a persist failure must fail the originating op (ADR-0004 Verify item 4,
  // no silent-degrade).
  test("setApiKey produces a secret.write audit row", async () => {
    const audit = makeAudit();
    const secrets = makeSecrets();
    const dispose = wireSubscriptions(audit, { secrets });

    await secrets.setApiKey("openai", "sk-test");

    const rows = await audit.query({ source: "secrets" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("secret.write");
    expect(rows[0]?.payload).toMatchObject({ provider: "openai", kind: "apiKey", op: "create" });
    // Never the secret value itself (ADR-0004 redaction).
    expect(JSON.stringify(rows[0])).not.toContain("sk-test");

    dispose();
  });

  test("a failing audit subscriber fails the originating setApiKey (no silent-degrade)", async () => {
    const audit = makeAudit();
    const secrets = makeSecrets();
    const dispose = wireSubscriptions(audit, { secrets });

    // Simulate a persist failure on the audited write path: a subscriber on the
    // same emitter throws. Because setApiKey now awaits the emit (4.2-A1),
    // the throw propagates and the write rejects — it is NOT silently swallowed.
    secrets.events.on("secret.write", () => {
      throw new Error("audit persist failed");
    });

    await expect(secrets.setApiKey("openai", "sk-test")).rejects.toThrow(/audit persist failed/);
    // Side effect not committed: the provider was never stored (emit-before-commit).
    expect(secrets.status("openai")).toBe("missing");

    dispose();
  });

  // Guard (ADR-0015 S1 / ADR-0016 C4): the thread.scope_set normalizer must
  // project EVERY scope axis it carries into the audit row. The store's own
  // tests cover EMISSION; this pins the AUDIT-NORMALIZER projection so a future
  // axis added to emission but dropped at the normalizer fails here — the audit
  // payload is an open Record, so the compiler cannot catch that omission.
  test("thread.scope_set audits every scope axis (model/effort/workingDir/backend)", async () => {
    const audit = makeAudit();
    const db = openHiveDb(":memory:");
    const threads = createThreadsStore(db);
    const dispose = wireSubscriptions(audit, { threads });

    const t = threads.create({ agentId: "agent-a" });
    await threads.setScope(t.id, {
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      workingDir: "/some/project",
      backend: "claude-code",
    });

    const rows = await audit.query({ source: "thread" });
    const row = rows.find((r) => r.event_type === "thread.scope_set");
    expect(row?.payload).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      workingDir: "/some/project",
      backend: "claude-code",
    });

    dispose();
  });

  // The `backend` source: a Run dispatches to an SDK backend (backend.run.started)
  // and the adapter folds observed tools (backend.tool_use.observed). Both emit
  // via the executor's `backendEvents`, REFS only (no args/output).
  test("backend.run.started + backend.tool_use.observed on `backend` source, redacted", async () => {
    const MODEL = "anthropic/claude-haiku-4-5";
    const audit = makeAudit();
    const secrets = makeSecrets();
    await secrets.setApiKey("anthropic", "sk-test");
    const db = openHiveDb(":memory:");
    const threads = createThreadsStore(db);
    const runsStore = createRunsStore(db);

    const agent: Agent = {
      agentId: AgentId.parse("tool-agent"),
      backend: "claude-code",
      domain: "t",
      bindings: { skills: [], snippets: [], tools: [], mcp: [] },
      config: { model: MODEL },
      promptBody: "",
      layer: "bundled",
      hasFork: false,
      path: "/p/HARNESS.md",
    };
    const catalogEvents = new TypedEmitter<Record<string, never>>();
    const catalog = {
      list: () => [agent],
      get: (id: string) => (id === agent.agentId ? agent : undefined),
      createAgent: async () => {
        throw new Error("nope");
      },
      destroyAgent: async () => {
        throw new Error("nope");
      },
      updateBindings: async () => {
        throw new Error("nope");
      },
      resetToBundled: async () => {
        throw new Error("nope");
      },
      start: async () => {},
      rescan: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: stub emitter; executor never reads catalog events.
      events: catalogEvents as any,
      dispose: () => {},
    };

    // The fake backend observes a tool with an isError flag and completes. The
    // adapter routes the observation through the invocation's onToolObserved
    // callback (the executor's backend audit emitter).
    const backend = fakeBackend((inv) => {
      inv.callbacks.onToolObserved("Bash", false);
      return [
        {
          type: "run.completed",
          runId: inv.runId,
          finishReason: "stop",
          finalMessage: {
            id: crypto.randomUUID(),
            threadId: inv.threadId,
            idx: 0,
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            createdAt: 1,
          },
          ts: 1,
        },
      ];
    });

    const executor = createRunExecutor({
      threads,
      runs: runsStore,
      catalog,
      secrets,
      adapters: { "claude-code": backend, codex: backend },
      mcpEndpoint: "http://127.0.0.1:3117/mcp",
    });
    const dispose = wireSubscriptions(audit, {
      runs: executor,
      backend: { events: executor.backendEvents },
    });

    const threadId = threads.create({ agentId: agent.agentId }).id;
    for await (const _ev of executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "go" }],
    })) {
      void _ev;
    }

    const backendRows = await audit.query({ source: "backend" });
    expect(backendRows.some((r) => r.event_type === "backend.run.started")).toBe(true);
    const observed = backendRows.find((r) => r.event_type === "backend.tool_use.observed");
    expect(observed).toBeDefined();
    expect((observed?.payload as { tool?: string }).tool).toBe("Bash");

    // No permission rows exist anymore (the permission source is deleted).
    const permRows = await audit.query({ source: "permission" });
    expect(permRows.length).toBe(0);

    // The run source still carries lifecycle.
    const runRows = await audit.query({ source: "run" });
    expect(runRows.some((r) => r.event_type === "run.started")).toBe(true);
    expect(runRows.some((r) => r.event_type === "run.completed")).toBe(true);

    dispose();
  });

  test("disposer detaches; later changes don't reach audit", async () => {
    const audit = makeAudit();
    const schema = z.object({ count: z.number() });
    const { svc: config, dispose: disposeConfig } = configRuntime({
      mode: "memory",
      initial: { count: 0 },
      schema,
    });
    const dispose = wireSubscriptions(audit, { config });

    await config.set("count", 1);
    dispose();
    await config.set("count", 2);

    const rows = await audit.query({ source: "config" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.payload).toMatchObject({ current: 1 });
    // Was: the second set("count", 2) — confirms the disposer detached.

    disposeConfig();
  });
});
