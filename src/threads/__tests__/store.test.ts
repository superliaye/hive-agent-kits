import { beforeEach, describe, expect, test } from "bun:test";
import { openHiveDb } from "../../db/hive-db.ts";
import { ThreadNotFoundError, type ThreadsStore, createThreadsStore } from "../store.ts";

let store: ThreadsStore;
let nowCounter: number;
let idCounter: number;

beforeEach(() => {
  const db = openHiveDb(":memory:");
  nowCounter = 1_000;
  idCounter = 0;
  store = createThreadsStore(
    db,
    () => ++nowCounter,
    () => `id-${++idCounter}`,
  );
});

describe("ThreadsStore.create + get", () => {
  test("create returns a row with generated id and timestamps", () => {
    const t = store.create({ agentId: "agent-a" });
    expect(t.id).toBe("id-1");
    expect(t.agentId).toBe("agent-a");
    expect(t.createdAt).toBe(1_001);
    expect(t.updatedAt).toBe(1_001);
  });

  test("create accepts an explicit id", () => {
    const t = store.create({ id: "thread-explicit", agentId: "agent-a" });
    expect(t.id).toBe("thread-explicit");
  });

  test("get returns undefined when thread is missing", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  test("get returns the persisted row", () => {
    const t = store.create({ agentId: "agent-a" });
    expect(store.get(t.id)).toEqual(t);
  });
});

describe("ThreadsStore.append", () => {
  test("assigns sequential idx values starting at 0", () => {
    const t = store.create({ agentId: "agent-a" });
    const m1 = store.append({
      threadId: t.id,
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    const m2 = store.append({
      threadId: t.id,
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(m1.idx).toBe(0);
    expect(m2.idx).toBe(1);
  });

  test("bumps the thread's updatedAt", () => {
    const t = store.create({ agentId: "agent-a" });
    const initialUpdated = t.updatedAt;
    store.append({
      threadId: t.id,
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    const refreshed = store.get(t.id);
    expect(refreshed?.updatedAt).toBeGreaterThan(initialUpdated);
  });

  test("throws ThreadNotFoundError when thread is missing", () => {
    expect(() =>
      store.append({
        threadId: "nope",
        role: "user",
        content: [{ type: "text", text: "x" }],
      }),
    ).toThrow(ThreadNotFoundError);
  });

  test("persists JSON content roundtrip including tool_use blocks", () => {
    const t = store.create({ agentId: "agent-a" });
    const content = [
      { type: "text" as const, text: "calling search" },
      { type: "tool_use" as const, id: "tu_1", name: "search", input: { q: "x" } },
    ];
    const m = store.append({ threadId: t.id, role: "assistant", content });
    const fetched = store.listMessages(t.id);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.id).toBe(m.id);
    expect(fetched[0]?.content).toEqual(content);
  });
});

describe("ThreadsStore.listMessages + getCompletionMessages", () => {
  test("listMessages returns messages in idx order", () => {
    const t = store.create({ agentId: "agent-a" });
    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "a" }] });
    store.append({ threadId: t.id, role: "assistant", content: [{ type: "text", text: "b" }] });
    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "c" }] });
    const out = store.listMessages(t.id).map((m) => m.content[0]);
    expect(out).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
    ]);
  });

  test("getCompletionMessages returns Message[] suitable for CompletionInput", () => {
    const t = store.create({ agentId: "agent-a" });
    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "hi" }] });
    const msgs = store.getCompletionMessages(t.id);
    expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("listMessages on missing thread returns empty array", () => {
    expect(store.listMessages("missing")).toEqual([]);
  });
});

describe("ThreadsStore.list + remove", () => {
  test("list returns threads sorted by updatedAt desc", () => {
    const t1 = store.create({ agentId: "agent-a" });
    const t2 = store.create({ agentId: "agent-a" });
    // Touch t1 again so it sorts ahead of t2
    store.append({ threadId: t1.id, role: "user", content: [{ type: "text", text: "x" }] });
    const ids = store.list().map((t) => t.id);
    expect(ids).toEqual([t1.id, t2.id]);
  });

  test("remove deletes the thread + cascades messages", () => {
    const t = store.create({ agentId: "agent-a" });
    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "x" }] });
    store.remove(t.id);
    expect(store.get(t.id)).toBeUndefined();
    expect(store.listMessages(t.id)).toEqual([]);
  });
});

describe("ThreadsStore.getWithMessages", () => {
  test("returns thread + messages array", () => {
    const t = store.create({ agentId: "agent-a" });
    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "hi" }] });
    const got = store.getWithMessages(t.id);
    expect(got?.id).toBe(t.id);
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0]?.role).toBe("user");
  });

  test("returns undefined for missing thread", () => {
    expect(store.getWithMessages("nope")).toBeUndefined();
  });
});
