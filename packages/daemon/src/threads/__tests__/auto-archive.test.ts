import { describe, expect, test } from "bun:test";
import { openHiveDb } from "../../db/hive-db.ts";
import { AUTO_ARCHIVE_IDLE_MS, autoArchiveSweep } from "../auto-archive.ts";
import { createThreadsStore, type ThreadsStore } from "../store.ts";

let store: ThreadsStore;
const NOW = 1_000_000_000_000;

// Build a thread whose `updated_at` we control by injecting `now` at create
// time, then advancing the store's clock for the sweep.
function makeStore(createdAt: number): ThreadsStore {
  const db = openHiveDb(":memory:");
  let idCounter = 0;
  return createThreadsStore(
    db,
    () => createdAt,
    () => `id-${++idCounter}`,
  );
}

describe("autoArchiveSweep (AC #5)", () => {
  test("archives an active thread idle longer than the idle window", async () => {
    const idleSince = NOW - AUTO_ARCHIVE_IDLE_MS - 1;
    store = makeStore(idleSince);
    const t = store.create({ agentId: "agent-a" });
    expect(store.get(t.id)?.archivedAt).toBeNull();
    await autoArchiveSweep(store, () => NOW);
    // The store owns the archive timestamp (its own clock), like the manual
    // path; the sweep's `now` only decides the idle cutoff. Both are Date.now
    // in production. Assert it transitioned to archived.
    expect(store.get(t.id)?.archivedAt).not.toBeNull();
  });

  test("leaves a thread within the idle window untouched", async () => {
    const recent = NOW - AUTO_ARCHIVE_IDLE_MS + 10_000;
    store = makeStore(recent);
    const t = store.create({ agentId: "agent-a" });
    await autoArchiveSweep(store, () => NOW);
    expect(store.get(t.id)?.archivedAt).toBeNull();
  });

  test("leaves an already-archived thread's timestamp untouched", async () => {
    const idleSince = NOW - AUTO_ARCHIVE_IDLE_MS - 1;
    store = makeStore(idleSince);
    const t = store.create({ agentId: "agent-a" });
    await store.archive(t.id, "manual"); // archived at `idleSince` (injected clock)
    const firstStamp = store.get(t.id)?.archivedAt;
    await autoArchiveSweep(store, () => NOW);
    expect(store.get(t.id)?.archivedAt).toBe(firstStamp ?? -1);
  });

  test("auto-archive emits NO thread.archived event (system-initiated → trace)", async () => {
    const idleSince = NOW - AUTO_ARCHIVE_IDLE_MS - 1;
    store = makeStore(idleSince);
    const seen: unknown[] = [];
    store.events.on("thread.archived", (e) => {
      seen.push(e);
    });
    store.create({ agentId: "agent-a" });
    await autoArchiveSweep(store, () => NOW);
    expect(seen).toEqual([]);
  });

  test("does not throw on an empty DB", async () => {
    store = makeStore(NOW);
    await expect(autoArchiveSweep(store, () => NOW)).resolves.toBeUndefined();
  });
});
