import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Layer, ManagedRuntime } from "effect";
import { TypedEmitter } from "../../../lib/typed-emitter.ts";
import type { Normalizer } from "../../types.ts";
import { Audit, AuditLive } from "../audit-live.ts";

type TestEvents = {
  "thing.happened": { id: string };
};

const normalizer: Normalizer<TestEvents> = {
  "thing.happened": (e) => ({ event_type: "thing.happened", payload: { id: e.id } }),
};

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const path = join(tmpdir(), `audit-live-${crypto.randomUUID()}.db`);
  tmpFiles.push(path);
  return path;
}

afterEach(() => {
  // Best-effort temp cleanup. On Windows the OS can hold a transient lock on a
  // just-closed sqlite file; leftover temp files are reclaimed by the OS and are
  // not the assertion under test.
  for (const path of tmpFiles.splice(0)) {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        rmSync(f, { force: true });
      } catch {
        // ignore transient Windows file lock
      }
    }
  }
});

describe("AuditLive", () => {
  test("resolves the service, persists an emitted event, queries it back", async () => {
    const runtime = ManagedRuntime.make(AuditLive({ mode: "memory" }));
    try {
      const svc = runtime.runSync(Audit);
      const emitter = new TypedEmitter<TestEvents>();
      svc.attach("backend", emitter, normalizer);
      await emitter.emit("thing.happened", { id: "abc" });

      const rows = await svc.query({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("backend");
      expect(rows[0]?.payload).toEqual({ id: "abc" });
      expect(svc.subscriptions()).toEqual(["backend"]);
    } finally {
      await runtime.dispose();
    }
  });

  test("dispose() closes the file handle exactly once; a fresh open on the same path still works", async () => {
    const path = tmpDbPath();
    const runtime = ManagedRuntime.make(AuditLive({ mode: "file", path }));
    const svc = runtime.runSync(Audit);
    // Sanity: the service works while the handle is open.
    expect(await svc.query({})).toEqual([]);

    await runtime.dispose();

    // The close ran (the thing that did NOT happen pre-4.2): the service's query
    // now hits a closed handle and throws, but the on-disk file is intact — a
    // fresh open succeeds.
    expect(() => svc.query({})).toThrow();
    const fresh = new Database(path);
    expect(() => fresh.exec("SELECT 1")).not.toThrow();
    fresh.close();
  });

  test("AuditLive is discharged: the layer requires nothing (R = never)", () => {
    // Type-level proof — if Audit leaked into the requirement set this would
    // not be assignable to Layer.Layer<Audit, never, never>.
    const root: Layer.Layer<Audit, never, never> = AuditLive({ mode: "memory" });
    expect(root).toBeDefined();
  });
});
