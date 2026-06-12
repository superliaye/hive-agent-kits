import { beforeEach, describe, expect, test } from "bun:test";
import { openHiveDb } from "../../db/hive-db.ts";
import { createThreadsStore, ThreadNotFoundError, type ThreadsStore } from "../store.ts";

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

  test("remove deletes the thread + cascades messages", async () => {
    const t = store.create({ agentId: "agent-a" });
    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "x" }] });
    await store.remove(t.id);
    expect(store.get(t.id)).toBeUndefined();
    expect(store.listMessages(t.id)).toEqual([]);
  });
});

describe("ThreadsStore.setTitle (AC #3 — title stickiness)", () => {
  test("manual title is sticky: a later auto write does not clobber it", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setTitle(t.id, "x", "manual");
    await store.setTitle(t.id, "y", "auto");
    const got = store.get(t.id);
    expect(got?.title).toBe("x");
    expect(got?.titleSource).toBe("manual");
  });

  test("auto write updates an auto/untitled thread", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setTitle(t.id, "z", "auto");
    const got = store.get(t.id);
    expect(got?.title).toBe("z");
    expect(got?.titleSource).toBe("auto");
  });

  test("manual write always overrides", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setTitle(t.id, "z", "auto");
    await store.setTitle(t.id, "q", "manual");
    const got = store.get(t.id);
    expect(got?.title).toBe("q");
    expect(got?.titleSource).toBe("manual");
  });

  test("does not bump updatedAt", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setTitle(t.id, "x", "manual");
    expect(store.get(t.id)?.updatedAt).toBe(t.updatedAt);
  });
});

describe("ThreadsStore.archive / markRead / markUnread (AC #4)", () => {
  test("archive sets archived_at and is idempotent (keeps first timestamp)", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.archive(t.id, "manual");
    const first = store.get(t.id)?.archivedAt;
    expect(first).not.toBeNull();
    await store.archive(t.id, "manual");
    expect(store.get(t.id)?.archivedAt).toBe(first ?? -1);
  });

  test("markRead sets last_read_at; markUnread clears it", async () => {
    const t = store.create({ agentId: "agent-a" });
    store.markRead(t.id, 4242);
    expect(store.get(t.id)?.lastReadAt).toBe(4242);
    await store.markUnread(t.id);
    expect(store.get(t.id)?.lastReadAt).toBeNull();
  });

  test("none of the lifecycle verbs bump updatedAt; append still does", async () => {
    const t = store.create({ agentId: "agent-a" });
    const base = t.updatedAt;
    await store.archive(t.id, "manual");
    store.markRead(t.id, 9999);
    await store.markUnread(t.id);
    await store.setTitle(t.id, "x", "manual");
    expect(store.get(t.id)?.updatedAt).toBe(base);

    store.append({ threadId: t.id, role: "user", content: [{ type: "text", text: "x" }] });
    expect(store.get(t.id)?.updatedAt).toBeGreaterThan(base);
  });
});

describe("ThreadsStore.listActiveIdleBefore", () => {
  test("returns only active threads with updatedAt strictly before the cutoff", async () => {
    const a = store.create({ agentId: "agent-a" }); // updatedAt 1001
    const b = store.create({ agentId: "agent-a" }); // updatedAt 1002
    await store.archive(a.id, "auto"); // archived → excluded regardless of age
    // cutoff 1002: b.updatedAt (1002) is NOT strictly before → empty.
    expect(store.listActiveIdleBefore(1002).map((t) => t.id)).toEqual([]);
    // cutoff 1003: b is active and 1002 < 1003 → included; a is archived → out.
    expect(store.listActiveIdleBefore(1003).map((t) => t.id)).toEqual([b.id]);
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

describe("ThreadsStore.setScope (S1, ADR-0015)", () => {
  test("fresh thread has null model/effort scope", () => {
    const t = store.create({ agentId: "agent-a" });
    expect(t.modelPref).toBeNull();
    expect(t.effortPref).toBeNull();
  });

  test("round-trips a model + effort pick", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setScope(t.id, { model: "openai-codex/gpt-5.5", effort: "minimal" });
    const got = store.get(t.id);
    expect(got?.modelPref).toBe("openai-codex/gpt-5.5");
    expect(got?.effortPref).toBe("minimal");
  });

  test("accepts a symbolic token", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setScope(t.id, { model: "latest", effort: "highest" });
    const got = store.get(t.id);
    expect(got?.modelPref).toBe("latest");
    expect(got?.effortPref).toBe("highest");
  });

  test("axes are independent — setting one leaves the other untouched", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setScope(t.id, { model: "anthropic/claude-sonnet-4-6" });
    await store.setScope(t.id, { effort: "high" });
    const got = store.get(t.id);
    expect(got?.modelPref).toBe("anthropic/claude-sonnet-4-6");
    expect(got?.effortPref).toBe("high");
  });

  test("null clears an axis without touching the other", async () => {
    const t = store.create({ agentId: "agent-a" });
    await store.setScope(t.id, { model: "anthropic/claude-sonnet-4-6", effort: "high" });
    await store.setScope(t.id, { model: null });
    const got = store.get(t.id);
    expect(got?.modelPref).toBeNull();
    expect(got?.effortPref).toBe("high");
  });

  test("does not bump updatedAt (metadata edit, not a message)", async () => {
    const t = store.create({ agentId: "agent-a" });
    const before = store.get(t.id)?.updatedAt;
    await store.setScope(t.id, { model: "anthropic/claude-haiku-4-5" });
    expect(store.get(t.id)?.updatedAt).toBe(before);
  });

  test("emits thread.scope_set (audit-first) with the touched axes", async () => {
    const t = store.create({ agentId: "agent-a" });
    const seen: Array<{ agentId: string; model?: string; effort?: string }> = [];
    store.events.on("thread.scope_set", (e) => {
      seen.push({
        agentId: e.agentId,
        ...(e.model ? { model: e.model } : {}),
        ...(e.effort ? { effort: e.effort } : {}),
      });
    });
    await store.setScope(t.id, { model: "openai-codex/gpt-5.5" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ agentId: "agent-a", model: "openai-codex/gpt-5.5" });
  });

  test("a cleared axis is named in `cleared` so clear-model and clear-effort differ", async () => {
    const t = store.create({ agentId: "agent-a" });
    const seen: Array<{ model?: string; effort?: string; cleared?: ("model" | "effort")[] }> = [];
    store.events.on("thread.scope_set", (e) => {
      seen.push({
        ...(e.model ? { model: e.model } : {}),
        ...(e.effort ? { effort: e.effort } : {}),
        ...(e.cleared ? { cleared: e.cleared } : {}),
      });
    });
    await store.setScope(t.id, { model: "openai-codex/gpt-5.5", effort: "minimal" });
    await store.setScope(t.id, { model: null });
    await store.setScope(t.id, { effort: null });
    expect(seen[1]).toEqual({ cleared: ["model"] });
    expect(seen[2]).toEqual({ cleared: ["effort"] });
  });

  test("rejects a no-op patch (neither axis present)", async () => {
    const t = store.create({ agentId: "agent-a" });
    await expect(store.setScope(t.id, {})).rejects.toThrow(/at least one/);
  });

  test("no-op on a missing thread", async () => {
    await store.setScope("nope", { model: "anthropic/claude-haiku-4-5" });
    expect(store.get("nope")).toBeUndefined();
  });
});

describe("ThreadsStore.getCliSession / setCliSession (CLI continuity, ADR-0016)", () => {
  test("fresh thread has no CLI session", () => {
    const t = store.create({ agentId: "agent-a" });
    expect(t.cliSessionBackend).toBeNull();
    expect(t.cliSessionId).toBeNull();
    expect(store.getCliSession(t.id)).toBeUndefined();
  });

  test("set then get round-trips the backend + session id", () => {
    const t = store.create({ agentId: "agent-a" });
    store.setCliSession(t.id, { backend: "claude-code", sessionId: "sess-abc" });
    expect(store.getCliSession(t.id)).toEqual({ backend: "claude-code", sessionId: "sess-abc" });
    const got = store.get(t.id);
    expect(got?.cliSessionBackend).toBe("claude-code");
    expect(got?.cliSessionId).toBe("sess-abc");
  });

  test("a later set overwrites the stored token", () => {
    const t = store.create({ agentId: "agent-a" });
    store.setCliSession(t.id, { backend: "claude-code", sessionId: "sess-1" });
    store.setCliSession(t.id, { backend: "codex", sessionId: "thr-2" });
    expect(store.getCliSession(t.id)).toEqual({ backend: "codex", sessionId: "thr-2" });
  });

  test("does not bump updatedAt (internal continuity state, not a message)", () => {
    const t = store.create({ agentId: "agent-a" });
    const before = store.get(t.id)?.updatedAt;
    store.setCliSession(t.id, { backend: "claude-code", sessionId: "sess-abc" });
    expect(store.get(t.id)?.updatedAt).toBe(before);
  });

  test("getCliSession returns undefined on a missing thread", () => {
    expect(store.getCliSession("nope")).toBeUndefined();
  });
});
