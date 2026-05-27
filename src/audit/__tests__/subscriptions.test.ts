/**
 * Integration tests for wireSubscriptions — the cross-module seam that
 * attaches emitter modules to the audit log.
 *
 * Audit covers user/agent-driven side effects (ADR-0004 "Audit vs trace"
 * amendment). System-driven scan/lifecycle events flow through the trace
 * log, not audit — verified here by asserting their absence.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createAudit } from "../audit.ts";
import { createConfig } from "../../config/index.ts";
import { createGateway } from "../../model-gateway/index.ts";
import type { GatewayAdapter } from "../../model-gateway/types.ts";
import { createRegistry } from "../../capabilities/index.ts";
import type { Capability } from "../../capabilities/types.ts";
import { createCatalog } from "../../catalog/index.ts";
import type { Agent } from "../../catalog/types.ts";
import { wireSubscriptions } from "../subscriptions.ts";

const fakeAdapter: GatewayAdapter = {
  providers: ["fake"],
  async *complete() {
    yield { type: "done", finishReason: "stop" };
  },
};

describe("wireSubscriptions", () => {
  test("config.set produces a config.change audit row", async () => {
    const audit = createAudit({ mode: "memory" });
    const schema = z.object({ theme: z.string() });
    const config = createConfig({
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
    config.dispose();
  });

  // Privacy redaction: the audit subscriber must strip color hex out of
  // `appearance` change payloads (mode-picker is fine, accent / overrides
  // are personal taste). Documented in audit/subscriptions.ts.
  test("appearance config.change records only the mode, never color hex", async () => {
    const audit = createAudit({ mode: "memory" });
    const schema = z.object({
      appearance: z.object({
        mode: z.enum(["light", "dark", "system"]),
        dark: z.object({ accent: z.string().optional() }).optional(),
      }),
    });
    const config = createConfig({
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
    config.dispose();
  });

  test("gateway adapter registration is NOT audited (trace, not audit)", async () => {
    const audit = createAudit({ mode: "memory" });
    const gateway = createGateway();
    const dispose = wireSubscriptions(audit, { gateway });

    const unregister = gateway.registerAdapter(fakeAdapter);
    unregister();

    const rows = await audit.query({ source: "gateway" });
    expect(rows.length).toBe(0);
    dispose();
  });

  test("registry.start() is NOT audited; scan-time events are trace-only", async () => {
    const audit = createAudit({ mode: "memory" });
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
    const audit = createAudit({ mode: "memory" });
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
    const catalog = createCatalog({
      scanner: () => ({ agents: [fakeAgent], errors: [] }),
      logErrors: false,
    });
    const dispose = wireSubscriptions(audit, { catalog });

    await catalog.start();

    // Scan-time agent.created should NOT appear in audit.
    const rows = await audit.query({ source: "catalog" });
    expect(rows.length).toBe(0);

    dispose();
    catalog.dispose();
  });

  test("disposer detaches; later changes don't reach audit", async () => {
    const audit = createAudit({ mode: "memory" });
    const schema = z.object({ count: z.number() });
    const config = createConfig({
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

    config.dispose();
  });
});
