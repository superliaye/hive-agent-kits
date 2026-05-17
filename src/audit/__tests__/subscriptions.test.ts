/**
 * Integration tests for wireSubscriptions — the cross-module seam that
 * attaches emitter modules to the audit log.
 *
 * Verifies:
 *   - Config changes produce audit.config.change rows
 *   - Gateway adapter registration/unregistration produce audit rows
 *   - The disposer detaches all listeners (no leak across tests)
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

  test("gateway adapter registration produces audit rows", async () => {
    const audit = createAudit({ mode: "memory" });
    const gateway = createGateway();
    const dispose = wireSubscriptions(audit, { gateway });

    const unregister = gateway.registerAdapter(fakeAdapter);
    // TypedEmitter.emit awaits listeners; the prior call already resolved.
    // No additional flush needed.

    // audit.query() orders newest first (ts DESC, seq DESC).
    const afterRegister = await audit.query({ source: "gateway" });
    expect(afterRegister.length).toBe(1);
    expect(afterRegister[0]?.event_type).toBe("gateway.adapter.registered");
    expect(afterRegister[0]?.payload).toMatchObject({ providers: ["fake"] });

    unregister();
    const afterUnregister = await audit.query({ source: "gateway" });
    expect(afterUnregister.length).toBe(2);
    expect(afterUnregister[0]?.event_type).toBe("gateway.adapter.unregistered");
    expect(afterUnregister[1]?.event_type).toBe("gateway.adapter.registered");

    dispose();
  });

  test("registry.start() produces capability.registered audit rows", async () => {
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
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("capability.registered");
    expect(rows[0]?.payload).toMatchObject({
      name: "foo",
      kind: "skill",
      origin: "personal",
      layer: "bundled",
      source: "filesystem",
    });

    dispose();
    registry.dispose();
  });

  test("catalog.start() produces agent.created audit rows", async () => {
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

    const rows = await audit.query({ source: "catalog" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("agent.created");
    expect(rows[0]?.agent_id).toBe("root");

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
