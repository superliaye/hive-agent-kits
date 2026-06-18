import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { Audit, AuditLive, type AuditSvc } from "../effect/audit-live.ts";
import type { Normalizer } from "../index.ts";

type TestEvents = {
  "thing.happened": { id: string };
  user_message: { text: string };
  with_links: { msg: string };
};

const baseNormalizer: Normalizer<TestEvents> = {
  "thing.happened": (e) => ({
    event_type: "thing.happened",
    payload: { id: e.id },
  }),
  user_message: (e) => ({
    event_type: "user_message",
    payload: { text: e.text },
  }),
  with_links: (e) => ({
    event_type: "with_links",
    payload: { msg: e.msg },
  }),
};

describe("audit module", () => {
  let audit: AuditSvc;
  let emitter: TypedEmitter<TestEvents>;
  let runtime: ManagedRuntime.ManagedRuntime<Audit, never>;

  beforeEach(() => {
    runtime = ManagedRuntime.make(AuditLive({ mode: "memory" }));
    audit = runtime.runSync(Audit);
    emitter = new TypedEmitter<TestEvents>();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  test("persists an emitted event", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "abc" });

    const rows = await audit.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("run");
    expect(rows[0]?.event_type).toBe("thing.happened");
    expect(rows[0]?.payload).toEqual({ id: "abc" });
  });

  test("returns rows in descending timestamp order", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "first" });
    await Bun.sleep(2);
    await emitter.emit("thing.happened", { id: "second" });

    const rows = await audit.query({});
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toMatchObject({ id: "second" });
    expect(rows[1]?.payload).toMatchObject({ id: "first" });
  });

  test("backstop redacts secret shapes anywhere in payload strings", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("user_message", {
      text: "my anthropic key is sk-ant-abcdefghij1234567890_-XYZ",
    });

    const rows = await audit.query({});
    const text = (rows[0]?.payload as { text: string }).text;
    expect(text).toContain("[REDACTED:anthropic-api]");
    expect(text).not.toContain("abcdefghij1234567890");
  });

  test("backstop walks nested objects and arrays", async () => {
    const nesting: Normalizer<TestEvents> = {
      ...baseNormalizer,
      user_message: (e) => ({
        event_type: "user_message",
        payload: {
          nested: { deeper: { token: e.text } },
          arr: ["plain", e.text, ["nested-arr", e.text]],
        },
      }),
    };
    audit.attach("run", emitter, nesting);
    await emitter.emit("user_message", { text: "ghp_abcdefghij1234567890_test" });

    const rows = await audit.query({});
    const payload = rows[0]?.payload as {
      nested: { deeper: { token: string } };
      arr: unknown[];
    };
    expect(payload.nested.deeper.token).toBe("[REDACTED:github-token]");
    expect(payload.arr).toEqual([
      "plain",
      "[REDACTED:github-token]",
      ["nested-arr", "[REDACTED:github-token]"],
    ]);
  });

  test("normalizer throw fails the emit (block-on-failure)", async () => {
    audit.attach("run", emitter, {
      ...baseNormalizer,
      "thing.happened": () => {
        throw new Error("normalizer rejected this event");
      },
    });
    await expect(emitter.emit("thing.happened", { id: "x" })).rejects.toThrow(
      "normalizer rejected",
    );
  });

  test("query filters by source", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "1" });

    expect(await audit.query({ source: "run" })).toHaveLength(1);
  });

  test("query filters by event_type", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "1" });
    await emitter.emit("user_message", { text: "hi" });

    expect(await audit.query({ event_type: "thing.happened" })).toHaveLength(1);
    expect(await audit.query({ event_type: "user_message" })).toHaveLength(1);
  });

  test("query filters by run_id", async () => {
    audit.attach("run", emitter, {
      ...baseNormalizer,
      "thing.happened": (e) => ({
        event_type: "thing.happened",
        payload: { id: e.id },
        run_id: "run-A",
      }),
      user_message: (e) => ({
        event_type: "user_message",
        payload: { text: e.text },
        run_id: "run-B",
      }),
    });
    await emitter.emit("thing.happened", { id: "1" });
    await emitter.emit("user_message", { text: "hi" });

    const aRows = await audit.query({ run_id: "run-A" });
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.run_id).toBe("run-A");
  });

  test("query filters by time range (microseconds)", async () => {
    audit.attach("run", emitter, baseNormalizer);
    const beforeMicros = Date.now() * 1000;
    await Bun.sleep(2);
    await emitter.emit("thing.happened", { id: "mid" });
    await Bun.sleep(2);
    const afterMicros = (Date.now() + 10) * 1000;

    const rows = await audit.query({ since: beforeMicros, until: afterMicros });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.find((r) => (r.payload as { id: string }).id === "mid")).toBeDefined();
  });

  test("query respects limit", async () => {
    audit.attach("run", emitter, baseNormalizer);
    for (let i = 0; i < 5; i++) {
      await emitter.emit("thing.happened", { id: `n${i}` });
    }
    expect(await audit.query({ limit: 3 })).toHaveLength(3);
  });

  test("populates id and ts on each row (microseconds since epoch)", async () => {
    audit.attach("run", emitter, baseNormalizer);
    const beforeMicros = Date.now() * 1000;
    await emitter.emit("thing.happened", { id: "x" });
    // Allow up to 10ms of slop on the upper bound (microsecond clock can
    // drift slightly behind Date.now()).
    const afterMicros = (Date.now() + 10) * 1000;

    const rows = await audit.query({});
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.ts).toBeGreaterThanOrEqual(beforeMicros);
    expect(rows[0]?.ts).toBeLessThanOrEqual(afterMicros);
  });

  test("seq is a monotonic counter, starts at 1, increments per emit", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "a" });
    await emitter.emit("thing.happened", { id: "b" });
    await emitter.emit("thing.happened", { id: "c" });

    const rows = await audit.query({});
    // Returned in descending order — newest first.
    expect(rows[0]?.seq).toBe(3);
    expect(rows[1]?.seq).toBe(2);
    expect(rows[2]?.seq).toBe(1);
  });

  test("rapid-fire emits order correctly via seq tiebreaker", async () => {
    audit.attach("run", emitter, baseNormalizer);
    // 20 emits with no awaits between them — many will share a microsecond
    // on a fast CPU. seq is what keeps the ordering deterministic.
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < 20; i++) {
      promises.push(emitter.emit("thing.happened", { id: `n${i}` }));
    }
    await Promise.all(promises);

    const rows = await audit.query({ limit: 20 });
    expect(rows).toHaveLength(20);
    // Descending order: last-emitted first.
    for (let i = 0; i < 20; i++) {
      expect((rows[i]?.payload as { id: string }).id).toBe(`n${19 - i}`);
    }
  });

  test("passes through parent_event_id and agent_id", async () => {
    audit.attach("run", emitter, {
      ...baseNormalizer,
      with_links: (e) => ({
        event_type: "with_links",
        payload: { msg: e.msg },
        parent_event_id: "parent-123",
        agent_id: "agent-xyz",
      }),
    });
    await emitter.emit("with_links", { msg: "x" });

    const rows = await audit.query({});
    expect(rows[0]?.parent_event_id).toBe("parent-123");
    expect(rows[0]?.agent_id).toBe("agent-xyz");
  });

  test("tamper-evidence columns are null in v1", async () => {
    audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "x" });

    const rows = await audit.query({});
    expect(rows[0]?.prev_hash).toBeNull();
    expect(rows[0]?.signature).toBeNull();
  });

  test("attach() returns a disposer that stops audit writes", async () => {
    const dispose = audit.attach("run", emitter, baseNormalizer);
    await emitter.emit("thing.happened", { id: "1" });
    dispose();
    await emitter.emit("thing.happened", { id: "2" });

    const rows = await audit.query({});
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { id: string }).id).toBe("1");
  });

  test("subscriptions() reports attached source modules", () => {
    expect(audit.subscriptions()).toEqual([]);
    audit.attach("run", emitter, baseNormalizer);
    expect(audit.subscriptions()).toEqual(["run"]);

    const otherEmitter = new TypedEmitter<TestEvents>();
    audit.attach("memory", otherEmitter, baseNormalizer);
    expect(audit.subscriptions()).toEqual(["run", "memory"]);
  });

  test("disposing removes the module from subscriptions()", () => {
    const dispose = audit.attach("run", emitter, baseNormalizer);
    expect(audit.subscriptions()).toEqual(["run"]);
    dispose();
    expect(audit.subscriptions()).toEqual([]);
  });
});
