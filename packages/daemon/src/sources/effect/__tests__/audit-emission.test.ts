// Sources → Audit seam: each registry mutation emits one refs-only audit row.
// Mirrors audit/__tests__/subscriptions.test.ts (memory audit + memory registry
// wired via wireSubscriptions). The registry verbs are Effect<A, E> with no
// requirements, so Effect.runPromise discharges them directly.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { AuditLive, type AuditSvc, Audit as AuditTag } from "../../../audit/effect/audit-live.ts";
import { wireSubscriptions } from "../../../audit/subscriptions.ts";
import {
  SourceRegistryLive,
  type SourceRegistrySvc,
  SourceRegistry as SourceRegistryTag,
} from "../sources-live.ts";

const runtimes: Array<{ dispose(): Promise<void> }> = [];

function makeAudit(): AuditSvc {
  const runtime = ManagedRuntime.make(AuditLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(AuditTag);
}

function makeRegistry(): SourceRegistrySvc {
  const runtime = ManagedRuntime.make(SourceRegistryLive({ mode: "memory" }));
  runtimes.push(runtime);
  return runtime.runSync(SourceRegistryTag);
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.dispose();
});

describe("sources audit emission", () => {
  test("add emits source.added with refs-only payload (id + normalized origin)", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    const source = await Effect.runPromise(
      registry.add("https://github.com/superliaye/my-agent-kits.git"),
    );

    const rows = await audit.query({ source: "sources" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("source.added");
    expect(rows[0]?.run_id).toBeNull();
    expect(rows[0]?.agent_id).toBeNull();
    expect(rows[0]?.payload).toEqual({
      id: source.id,
      origin: "https://github.com/superliaye/my-agent-kits",
    });
  });

  test("activate/deactivate/delete each emit one refs-only row carrying only the id", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    const source = await Effect.runPromise(registry.add("https://example.com/a/b"));
    await Effect.runPromise(registry.deactivate(source.id));
    await Effect.runPromise(registry.activate(source.id));
    await Effect.runPromise(registry.delete(source.id));

    // Audit query returns newest-first (total order ts DESC, seq DESC).
    const rows = await audit.query({ source: "sources" });
    expect(rows.map((r) => r.event_type)).toEqual([
      "source.removed",
      "source.activated",
      "source.deactivated",
      "source.added",
    ]);
    for (const type of ["source.activated", "source.deactivated", "source.removed"]) {
      expect(rows.find((r) => r.event_type === type)?.payload).toEqual({ id: source.id });
    }
  });

  test("a duplicate-origin add emits no audit row", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    await Effect.runPromise(registry.add("https://example.com/a/b"));
    // The .git/trailing-slash variant normalizes to the same origin → DuplicateOrigin.
    await Effect.runPromiseExit(registry.add("https://example.com/a/b.git"));

    const rows = await audit.query({ source: "sources" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("source.added");
  });
});
