import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { z } from "zod";
import { createConfig } from "../../index.ts";
import { configRuntime } from "../config-live.ts";

const schema = z.object({ count: z.number(), label: z.string() });
type S = z.infer<typeof schema>;
const initial: S = { count: 0, label: "a" };

describe("ConfigLive", () => {
  test("set() updates a subsequent get() and fires an active watch listener", async () => {
    const cfg = createConfig({ mode: "memory", initial, schema });
    const seen: number[] = [];
    const off = cfg.watch("count", (v) => seen.push(v)); // initial fire: 0
    await cfg.set("count", 5);
    expect(cfg.get("count")).toBe(5);
    expect(seen).toEqual([0, 5]);
    off();
    cfg.dispose();
  });

  test("changes stream is the reactive state cell — reflects updates", async () => {
    const { svc, dispose } = configRuntime({ mode: "memory", initial, schema });
    await svc.set("count", 9);
    // SubscriptionRef.changes emits the current value first; after the set the
    // cell holds {count:9}, proving the ref was updated in lockstep.
    const cur = await Effect.runPromise(Stream.runCollect(Stream.take(svc.changes, 1)));
    expect(cur[0]).toEqual({ count: 9, label: "a" });
    dispose();
  });
});
