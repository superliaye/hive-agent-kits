import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HiveDb, HiveDbLive } from "../../../db/effect/hive-db-live.ts";
import { createThreadsStore } from "../../store.ts";
import { Threads, ThreadsLive } from "../threads-live.ts";

describe("ThreadsLive", () => {
  test("shares the ONE root HiveDb connection (no second handle)", async () => {
    // Bind the data layer ONCE so the merge and the ThreadsLive branch reference
    // the same layer value — ManagedRuntime memoizes it to one connection.
    const dataLayer = HiveDbLive(":memory:");
    const root = Layer.mergeAll(dataLayer, ThreadsLive().pipe(Layer.provide(dataLayer)));
    const runtime = ManagedRuntime.make(root);
    try {
      const { threads, hiveDb } = await runtime.runPromise(
        Effect.gen(function* () {
          return { threads: yield* Threads, hiveDb: yield* HiveDb };
        }),
      );
      const created = threads.create({ agentId: "a1" });
      // A store built over the SAME resolved HiveDb handle sees the row — proves
      // a shared *connection*, not merely a shared tag.
      const direct = createThreadsStore(hiveDb);
      expect(direct.get(created.id)?.id).toBe(created.id);
    } finally {
      await runtime.dispose();
    }
  });

  test("dispose() closes the shared connection exactly once", async () => {
    const dataLayer = HiveDbLive(":memory:");
    const root = Layer.mergeAll(dataLayer, ThreadsLive().pipe(Layer.provide(dataLayer)));
    const runtime = ManagedRuntime.make(root);
    const hiveDb = await runtime.runPromise(HiveDb);
    hiveDb.$client.exec("SELECT 1");

    await runtime.dispose();

    expect(() => hiveDb.$client.exec("SELECT 1")).toThrow();
  });

  test("R is HiveDb, discharged at the root (not leaked)", () => {
    // Type-level: ThreadsLive() requires HiveDb; after Layer.provide(HiveDbLive)
    // that requirement is discharged, leaving R = never (not leaked upward).
    const live: Layer.Layer<Threads, never, HiveDb> = ThreadsLive();
    const discharged: Layer.Layer<Threads, never, never> = live.pipe(
      Layer.provide(HiveDbLive(":memory:")),
    );
    expect(discharged).toBeDefined();
  });
});
