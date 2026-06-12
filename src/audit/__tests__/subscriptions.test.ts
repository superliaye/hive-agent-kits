/**
 * Integration tests for wireSubscriptions — the cross-module seam that
 * attaches emitter modules to the audit log.
 *
 * Audit covers user/agent-driven side effects (ADR-0004 "Audit vs trace"
 * amendment). System-driven scan/lifecycle events flow through the trace
 * log, not audit — verified here by asserting their absence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { z } from "zod";
import { createRegistry } from "../../capabilities/index.ts";
import type { Capability } from "../../capabilities/types.ts";
import { CatalogLive, Catalog as CatalogTag } from "../../catalog/effect/catalog-live.ts";
import type { Agent } from "../../catalog/types.ts";
import { configRuntime } from "../../config/effect/config-live.ts";
import { openHiveDb } from "../../db/hive-db.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { makeFakeAdapter } from "../../model-gateway/adapters/fake.ts";
import { createGateway } from "../../model-gateway/index.ts";
import type { CompletionInput, GatewayAdapter, GatewayEvent } from "../../model-gateway/types.ts";
import type { ShellRunnerPort } from "../../runs/effect/ports.ts";
import { createRunExecutor } from "../../runs/executor.ts";
import { createRunsStore } from "../../runs/store.ts";
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

const fakeAdapter: GatewayAdapter = {
  providers: ["fake"],
  async *complete() {
    yield { type: "done", finishReason: "stop" };
  },
};

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

  test("gateway adapter registration is NOT audited (trace, not audit)", async () => {
    const audit = makeAudit();
    const gateway = createGateway();
    const dispose = wireSubscriptions(audit, { gateway });

    const unregister = gateway.registerAdapter(fakeAdapter);
    unregister();

    const rows = await audit.query({ source: "gateway" });
    expect(rows.length).toBe(0);
    dispose();
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
      agentId: "root",
      backend: "native",
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
  test("thread.scope_set audits every scope axis (model/effort/workingDir)", async () => {
    const audit = makeAudit();
    const db = openHiveDb(":memory:");
    const threads = createThreadsStore(db);
    const dispose = wireSubscriptions(audit, { threads });

    const t = threads.create({ agentId: "agent-a" });
    await threads.setScope(t.id, {
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      workingDir: "/some/project",
    });

    const rows = await audit.query({ source: "thread" });
    const row = rows.find((r) => r.event_type === "thread.scope_set");
    expect(row?.payload).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      workingDir: "/some/project",
    });

    dispose();
  });

  // F1: tool-use rows land on the `run` source; permission decisions on the
  // dedicated `permission` source (Q4) — both via wireSubscriptions, through
  // the executor's two emitters, with redaction (no raw args, no stdout).
  test("run.tool_use.* on `run` source + permission.* on `permission` source, redacted", async () => {
    const MODEL = "anthropic/claude-haiku-4-5";
    const audit = makeAudit();
    const secrets = makeSecrets();
    await secrets.setApiKey("anthropic", "sk-test");
    const db = openHiveDb(":memory:");
    const threads = createThreadsStore(db);
    const runsStore = createRunsStore(db);

    const agent: Agent = {
      agentId: "tool-agent",
      backend: "native",
      domain: "t",
      bindings: { skills: [], snippets: [], tools: ["run_shell"], mcp: [] },
      config: { model: MODEL },
      commandAllowlist: ["node"],
      promptBody: "",
      layer: "bundled",
      hasFork: false,
      path: "/p/HARNESS.md",
    };
    const catalogEvents = new TypedEmitter<Record<string, never>>();
    const catalog = {
      list: () => [agent],
      get: (id: string) => (id === agent.agentId ? agent : undefined),
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

    // tool_use turn, then a text turn once a tool_result exists in history.
    const script = (input: CompletionInput): GatewayEvent[] => {
      const hasResult = input.messages
        .flatMap((m) => m.content)
        .some((b) => b.type === "tool_result");
      if (hasResult) {
        return [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "done" },
          { type: "text_end", blockIndex: 0 },
          { type: "done", finishReason: "stop" },
        ];
      }
      return [
        { type: "tool_use_start", blockIndex: 0, id: "tu_1", name: "run_shell" },
        {
          type: "tool_use_end",
          blockIndex: 0,
          id: "tu_1",
          args: { command: "node", args: ["--secret"] },
        },
        { type: "done", finishReason: "tool_use" },
      ];
    };
    const gateway = createGateway();
    gateway.registerAdapter(makeFakeAdapter(["anthropic"], { [MODEL]: script }));
    const shell: ShellRunnerPort = {
      run: async () => ({ stdout: "REDACTED-STDOUT", stderr: "", exitCode: 0 }),
    };

    const executor = createRunExecutor({
      threads,
      runs: runsStore,
      catalog,
      gateway,
      secrets,
      shell,
    });
    const dispose = wireSubscriptions(audit, {
      runs: executor,
      permission: { events: executor.permissionEvents },
    });

    const threadId = threads.create({ agentId: agent.agentId }).id;
    for await (const _ev of executor.startRun({
      threadId,
      userMessage: [{ type: "text", text: "go" }],
    })) {
      void _ev;
    }

    const runRows = await audit.query({ source: "run" });
    expect(runRows.some((r) => r.event_type === "run.tool_use.requested")).toBe(true);
    expect(runRows.some((r) => r.event_type === "run.tool_use.executed")).toBe(true);

    const permRows = await audit.query({ source: "permission" });
    expect(permRows.some((r) => r.event_type === "permission.requested")).toBe(true);
    const decided = permRows.find((r) => r.event_type === "permission.decided");
    expect(decided).toBeDefined();
    expect((decided?.payload as { outcome?: string }).outcome).toBe("allow");

    // Redaction: no raw arg, no stdout anywhere in the persisted rows; the
    // command NAME (ref) IS present.
    const blob = JSON.stringify([...runRows, ...permRows]);
    expect(blob).not.toContain("--secret");
    expect(blob).not.toContain("REDACTED-STDOUT");
    expect(blob).toContain("node");

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
