import { beforeEach, describe, expect, test } from "bun:test";
import { openHiveDb } from "../../db/hive-db.ts";
import { AgentId } from "../../lib/ids.ts";
import { createThreadsStore, type ThreadsStore } from "../store.ts";
import type { ThreadEvents } from "../types.ts";

let store: ThreadsStore;
let nowValue: number;

beforeEach(() => {
  const db = openHiveDb(":memory:");
  nowValue = 5_000;
  let idCounter = 0;
  store = createThreadsStore(
    db,
    () => nowValue,
    () => `id-${++idCounter}`,
  );
});

function capture<K extends keyof ThreadEvents>(type: K): ThreadEvents[K][] {
  const seen: ThreadEvents[K][] = [];
  store.events.on(type, (e) => {
    seen.push(e);
  });
  return seen;
}

describe("Threads emitter — emits on explicit/manual actions (Item 3)", () => {
  test("manual archive emits thread.archived with refs (threadId + agentId)", async () => {
    const archived = capture("thread.archived");
    const t = store.create({ agentId: "agent-a" });
    await store.archive(t.id, "manual");
    expect(archived).toEqual([{ threadId: t.id, agentId: AgentId.parse("agent-a") }]);
  });

  test("manual rename emits thread.title_set carrying titleSource, NOT the title", async () => {
    const titleSet = capture("thread.title_set");
    const t = store.create({ agentId: "agent-a" });
    await store.setTitle(t.id, "secret title", "manual");
    expect(titleSet).toEqual([
      { threadId: t.id, agentId: AgentId.parse("agent-a"), titleSource: "manual" },
    ]);
    // The title string must never ride the event payload (refs not values).
    expect(JSON.stringify(titleSet)).not.toContain("secret title");
  });

  test("markUnread emits thread.marked_unread", async () => {
    const unread = capture("thread.marked_unread");
    const t = store.create({ agentId: "agent-a" });
    await store.markUnread(t.id);
    expect(unread).toEqual([{ threadId: t.id, agentId: AgentId.parse("agent-a") }]);
  });

  test("remove emits thread.deleted", async () => {
    const deleted = capture("thread.deleted");
    const t = store.create({ agentId: "agent-a" });
    await store.remove(t.id);
    expect(deleted).toEqual([{ threadId: t.id, agentId: AgentId.parse("agent-a") }]);
  });
});

describe("Threads emitter — auto/non-emitting paths produce NO event", () => {
  test("auto archive does not emit thread.archived", async () => {
    const archived = capture("thread.archived");
    const t = store.create({ agentId: "agent-a" });
    await store.archive(t.id, "auto");
    expect(store.get(t.id)?.archivedAt).not.toBeNull(); // it DID archive
    expect(archived).toEqual([]); // but emitted nothing
  });

  test("auto title write does not emit thread.title_set", async () => {
    const titleSet = capture("thread.title_set");
    const t = store.create({ agentId: "agent-a" });
    await store.setTitle(t.id, "auto title", "auto");
    expect(store.get(t.id)?.title).toBe("auto title");
    expect(titleSet).toEqual([]);
  });

  test("markRead does not emit (not an audited verb)", () => {
    const unread = capture("thread.marked_unread");
    const t = store.create({ agentId: "agent-a" });
    store.markRead(t.id, 1234);
    expect(unread).toEqual([]);
  });

  test("idempotent second archive emits nothing (no state change)", async () => {
    const archived = capture("thread.archived");
    const t = store.create({ agentId: "agent-a" });
    await store.archive(t.id, "manual");
    await store.archive(t.id, "manual");
    expect(archived).toHaveLength(1);
  });
});

describe("Threads emitter — audit-first / block-on-failure (AC #6)", () => {
  test("a throwing listener rejects the op and the DB row is NOT mutated", async () => {
    const t = store.create({ agentId: "agent-a" });
    store.events.on("thread.archived", () => {
      throw new Error("audit persist failed");
    });
    await expect(store.archive(t.id, "manual")).rejects.toThrow("audit persist failed");
    // Audit-first: the emit precedes the write, so a throwing listener leaves
    // the thread un-archived.
    expect(store.get(t.id)?.archivedAt).toBeNull();
  });

  test("a throwing listener on delete leaves the thread present", async () => {
    const t = store.create({ agentId: "agent-a" });
    store.events.on("thread.deleted", () => {
      throw new Error("audit persist failed");
    });
    await expect(store.remove(t.id)).rejects.toThrow("audit persist failed");
    expect(store.get(t.id)?.id).toBe(t.id);
  });
});
