import { beforeEach, describe, expect, test } from "bun:test";
import { openHiveDb } from "../../db/hive-db.ts";
import { createThreadsStore } from "../../threads/store.ts";
import { createRunsStore, type RunsStore } from "../store.ts";

let runs: RunsStore;
let nowCounter: number;
let threadId: string;

beforeEach(() => {
  const db = openHiveDb(":memory:");
  nowCounter = 1_000;
  runs = createRunsStore(db, () => ++nowCounter);
  // FK requires a thread to exist before runs reference it.
  const threads = createThreadsStore(db);
  threadId = threads.create({ agentId: "agent-a" }).id;
});

describe("RunsStore lifecycle", () => {
  test("create returns a `running` row with timestamps", () => {
    const r = runs.create({ threadId, agentId: "agent-a", model: "anthropic/x" });
    expect(r.status).toBe("running");
    expect(r.startedAt).toBe(1_001);
    expect(r.endedAt).toBeUndefined();
    expect(r.finishReason).toBeUndefined();
  });

  test("complete flips status to completed with finishReason", () => {
    const r = runs.create({ threadId, agentId: "agent-a", model: "anthropic/x" });
    runs.complete({ runId: r.id, finishReason: "stop" });
    const refreshed = runs.get(r.id);
    expect(refreshed?.status).toBe("completed");
    expect(refreshed?.finishReason).toBe("stop");
    expect(refreshed?.endedAt).toBe(1_002);
  });

  test("fail captures code + message", () => {
    const r = runs.create({ threadId, agentId: "agent-a", model: "anthropic/x" });
    runs.fail({ runId: r.id, code: "auth_failed", message: "401 unauthorized" });
    const refreshed = runs.get(r.id);
    expect(refreshed?.status).toBe("failed");
    expect(refreshed?.errorCode).toBe("auth_failed");
    expect(refreshed?.errorMessage).toBe("401 unauthorized");
  });

  test("cancel flips status to cancelled", () => {
    const r = runs.create({ threadId, agentId: "agent-a", model: "anthropic/x" });
    runs.cancel(r.id);
    expect(runs.get(r.id)?.status).toBe("cancelled");
  });

  test("complete/fail/cancel on already-finalized Run is a no-op", () => {
    const r = runs.create({ threadId, agentId: "agent-a", model: "anthropic/x" });
    runs.complete({ runId: r.id, finishReason: "stop" });
    runs.fail({ runId: r.id, code: "unknown", message: "ignored" });
    runs.cancel(r.id);
    const refreshed = runs.get(r.id);
    expect(refreshed?.status).toBe("completed");
    expect(refreshed?.errorCode).toBeUndefined();
  });
});

describe("RunsStore queries", () => {
  test("listByThread sorts by startedAt ascending", () => {
    const r1 = runs.create({ threadId, agentId: "a", model: "anthropic/x" });
    const r2 = runs.create({ threadId, agentId: "a", model: "anthropic/x" });
    const ids = runs.listByThread(threadId).map((r) => r.id);
    expect(ids).toEqual([r1.id, r2.id]);
  });

  test("listByStatus returns only matching rows", () => {
    const r1 = runs.create({ threadId, agentId: "a", model: "anthropic/x" });
    const r2 = runs.create({ threadId, agentId: "a", model: "anthropic/x" });
    runs.complete({ runId: r1.id, finishReason: "stop" });
    expect(runs.listByStatus("running").map((r) => r.id)).toEqual([r2.id]);
    expect(runs.listByStatus("completed").map((r) => r.id)).toEqual([r1.id]);
  });
});

describe("RunsStore.markStaleAsFailed", () => {
  test("flips all `running` rows to `failed(daemon_restart)`", () => {
    const r1 = runs.create({ threadId, agentId: "a", model: "anthropic/x" });
    const r2 = runs.create({ threadId, agentId: "a", model: "anthropic/x" });
    runs.complete({ runId: r1.id, finishReason: "stop" });
    expect(runs.markStaleAsFailed()).toBe(1);
    const stale = runs.get(r2.id);
    expect(stale?.status).toBe("failed");
    expect(stale?.errorCode).toBe("daemon_restart");
  });

  test("returns 0 when no Runs are in-flight", () => {
    expect(runs.markStaleAsFailed()).toBe(0);
  });
});
