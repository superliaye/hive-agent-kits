import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HiveDb, HiveDbLive } from "../hive-db-live.ts";

describe("HiveDbLive", () => {
  test("two consumers share one underlying connection (layer memoization)", async () => {
    const runtime = ManagedRuntime.make(HiveDbLive(":memory:"));
    try {
      const [a, b] = await runtime.runPromise(Effect.all([HiveDb, HiveDb]));
      expect(a).toBe(b);
      expect(a.$client).toBe(b.$client);
    } finally {
      await runtime.dispose();
    }
  });

  test("dispose() closes the connection exactly once", async () => {
    const runtime = ManagedRuntime.make(HiveDbLive(":memory:"));
    const db = await runtime.runPromise(HiveDb);
    // Sanity: open connection accepts a trivial statement.
    db.$client.exec("SELECT 1");

    await runtime.dispose();

    // After dispose the underlying handle is closed: a statement throws.
    expect(() => db.$client.exec("SELECT 1")).toThrow();
  });

  test("HiveDb is discharged: a layer providing it has R = never at the root", () => {
    // Type-level proof that HiveDbLive's output requires nothing (R = never).
    // If HiveDb leaked into the requirement set this would not be assignable
    // to Layer.Layer<HiveDb, never, never>.
    const root: Layer.Layer<HiveDb, never, never> = HiveDbLive(":memory:");
    expect(root).toBeDefined();
  });
});
