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

function gitInput(repoUrl: string) {
  return {
    label: repoUrl,
    locator: {
      kind: "git" as const,
      repoUrl,
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    },
  };
}

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
      registry.add(gitInput("https://github.com/superliaye/my-agent-kits.git")),
    );

    const rows = await audit.query({ source: "sources" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("source.added");
    expect(rows[0]?.run_id).toBeNull();
    expect(rows[0]?.agent_id).toBeNull();
    expect(rows[0]?.payload).toEqual({
      id: source.id,
      kind: "git",
      origin: "https://github.com/superliaye/my-agent-kits",
    });
  });

  test("working-tree add audit keeps the locator path private", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });
    const repoRoot = "/private/daemon/worktree";

    const source = await Effect.runPromise(
      registry.add({
        label: "Working tree",
        locator: { kind: "working-tree", repoRoot, subpath: "." },
      }),
    );

    const rows = await audit.query({ source: "sources" });
    expect(rows[0]?.payload).toEqual({ id: source.id, kind: "working-tree" });
    expect(JSON.stringify(rows)).not.toContain(repoRoot);
  });

  test("activate/deactivate/delete each emit one refs-only row carrying only the id", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    const source = await Effect.runPromise(registry.add(gitInput("https://example.com/a/b")));
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

  test("reorder emits source.reordered with a refs-only payload (id + new rank, no values)", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    // Two adds: a (rank lower), b (rank higher). Raise a above b.
    const a = await Effect.runPromise(registry.add(gitInput("https://github.com/a/lower")));
    await Effect.runPromise(registry.add(gitInput("https://github.com/b/higher")));
    const reordered = await Effect.runPromise(registry.reorder(a.id, "up"));

    const rows = await audit.query({ source: "sources" });
    const row = rows.find((r) => r.event_type === "source.reordered");
    expect(row).toBeDefined();
    expect(row?.run_id).toBeNull();
    expect(row?.agent_id).toBeNull();
    // Refs only: the id + its NEW rank — never origins or file contents.
    expect(row?.payload).toEqual({ id: a.id, rank: reordered.rank });
    const payload = row?.payload as Record<string, unknown> | undefined;
    expect(payload?.origin).toBeUndefined();
  });

  test("reorder of an unknown id fails (SourceNotFound) and emits no audit row", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    await Effect.runPromiseExit(registry.reorder("nope", "up"));
    const rows = await audit.query({ source: "sources" });
    expect(rows.some((r) => r.event_type === "source.reordered")).toBe(false);
  });

  test("a NO-OP reorder (already at the end) emits NO audit row", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    // One added Source (the highest rank). Moving it up is a no-op — no row.
    const a = await Effect.runPromise(registry.add(gitInput("https://github.com/a/b")));
    await Effect.runPromise(registry.reorder(a.id, "up"));

    const rows = await audit.query({ source: "sources" });
    expect(rows.some((r) => r.event_type === "source.reordered")).toBe(false);
  });

  test("a duplicate-origin add emits no audit row", async () => {
    const audit = makeAudit();
    const registry = makeRegistry();
    wireSubscriptions(audit, { sourceRegistry: { events: registry.events } });

    await Effect.runPromise(registry.add(gitInput("https://example.com/a/b")));
    // The .git/trailing-slash variant normalizes to the same origin → DuplicateOrigin.
    await Effect.runPromiseExit(registry.add(gitInput("https://example.com/a/b.git")));

    const rows = await audit.query({ source: "sources" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe("source.added");
  });
});
