/**
 * thread-nav pure core — group / sort / paginate / status derivation.
 * Sub-second under bun test; the React + EventSource wiring on top is
 * exercised by the Playwright e2e.
 */

import { describe, expect, test } from "bun:test";
import type { ThreadSummary } from "../api.ts";
import {
  groupByAgent,
  PAGE_SIZE,
  paginate,
  sortThreads,
  statusDot,
  statusMeta,
  threadTitle,
  UNTITLED_PLACEHOLDER,
} from "../thread-nav.ts";

function makeThread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: over.id ?? `t-${Math.random().toString(36).slice(2)}`,
    agentId: "root",
    createdAt: 1_000,
    updatedAt: 1_000,
    title: null,
    titleSource: "auto",
    archivedAt: null,
    status: "idle",
    ...over,
  };
}

describe("groupByAgent", () => {
  test("one header per distinct agentId", () => {
    const groups = groupByAgent([
      makeThread({ agentId: "a" }),
      makeThread({ agentId: "b" }),
      makeThread({ agentId: "a" }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(["a", "b"].sort());
    expect(groups.find((g) => g.agentId === "a")?.threads).toHaveLength(2);
    expect(groups.find((g) => g.agentId === "b")?.threads).toHaveLength(1);
  });

  test("group order is by most-recent thread desc, then agentId asc", () => {
    const groups = groupByAgent([
      makeThread({ agentId: "old", updatedAt: 100 }),
      makeThread({ agentId: "new", updatedAt: 900 }),
      makeThread({ agentId: "mid", updatedAt: 500 }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(["new", "mid", "old"]);
  });

  test("group recency uses the max within the group, not any single thread", () => {
    const groups = groupByAgent([
      makeThread({ agentId: "a", updatedAt: 100 }),
      makeThread({ agentId: "a", updatedAt: 999 }),
      makeThread({ agentId: "b", updatedAt: 500 }),
    ]);
    // a wins because one of its threads (999) beats b's 500.
    expect(groups.map((g) => g.agentId)).toEqual(["a", "b"]);
  });

  test("equal recency falls back to agentId asc (deterministic)", () => {
    const groups = groupByAgent([
      makeThread({ agentId: "zebra", updatedAt: 500 }),
      makeThread({ agentId: "alpha", updatedAt: 500 }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(["alpha", "zebra"]);
  });

  test("each group is internally sorted", () => {
    const groups = groupByAgent([
      makeThread({ agentId: "a", id: "old", updatedAt: 100 }),
      makeThread({ agentId: "a", id: "new", updatedAt: 900 }),
    ]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["new", "old"]);
  });
});

describe("sortThreads", () => {
  test("non-archived before archived", () => {
    const out = sortThreads([
      makeThread({ id: "arch", archivedAt: 5_000, updatedAt: 9_000 }),
      makeThread({ id: "live", archivedAt: null, updatedAt: 1_000 }),
    ]);
    // Archived sorts below even though it has a newer updatedAt.
    expect(out.map((t) => t.id)).toEqual(["live", "arch"]);
  });

  test("within a bucket, newest interaction first", () => {
    const out = sortThreads([
      makeThread({ id: "a", updatedAt: 100 }),
      makeThread({ id: "b", updatedAt: 300 }),
      makeThread({ id: "c", updatedAt: 200 }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  test("archived bucket is also newest-first", () => {
    const out = sortThreads([
      makeThread({ id: "old-arch", archivedAt: 1, updatedAt: 100 }),
      makeThread({ id: "new-arch", archivedAt: 1, updatedAt: 800 }),
      makeThread({ id: "live", archivedAt: null, updatedAt: 50 }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["live", "new-arch", "old-arch"]);
  });

  test("pure — does not mutate input", () => {
    const input = [makeThread({ id: "a", updatedAt: 1 }), makeThread({ id: "b", updatedAt: 2 })];
    const before = input.map((t) => t.id);
    sortThreads(input);
    expect(input.map((t) => t.id)).toEqual(before);
  });
});

describe("paginate", () => {
  const many = (n: number, over: Partial<ThreadSummary> = {}): ThreadSummary[] =>
    Array.from({ length: n }, (_, i) =>
      makeThread({ id: `t${i}`, updatedAt: 10_000 - i, ...over }),
    );

  test("under PAGE_SIZE → all visible, no control", () => {
    const sorted = sortThreads(many(5));
    const view = paginate(sorted, false);
    expect(view.visible).toHaveLength(5);
    expect(view.label).toBe("none");
  });

  test("exactly PAGE_SIZE → all visible, no control", () => {
    const view = paginate(sortThreads(many(PAGE_SIZE)), false);
    expect(view.visible).toHaveLength(PAGE_SIZE);
    expect(view.label).toBe("none");
  });

  test("over PAGE_SIZE with hidden non-archived → load-more, exactly PAGE_SIZE shown", () => {
    const view = paginate(sortThreads(many(PAGE_SIZE + 5)), false);
    expect(view.visible).toHaveLength(PAGE_SIZE);
    expect(view.label).toBe("load-more");
  });

  test("expanded reveals everything", () => {
    const sorted = sortThreads(many(PAGE_SIZE + 5));
    const view = paginate(sorted, true);
    expect(view.visible).toHaveLength(PAGE_SIZE + 5);
    expect(view.label).toBe("none");
  });

  test("when only hidden rows are archived → load-archived", () => {
    // PAGE_SIZE non-archived (all visible) + extra archived (hidden).
    const live = many(PAGE_SIZE, { archivedAt: null });
    const archived = Array.from({ length: 3 }, (_, i) =>
      makeThread({ id: `arch${i}`, archivedAt: 1, updatedAt: 1 }),
    );
    const sorted = sortThreads([...live, ...archived]);
    const view = paginate(sorted, false);
    expect(view.visible).toHaveLength(PAGE_SIZE);
    expect(view.label).toBe("load-archived");
    // The hidden rows are exactly the archived ones.
    expect(view.visible.every((t) => t.archivedAt === null)).toBe(true);
  });

  test("hidden mix of non-archived and archived → load-more (non-archived wins the label)", () => {
    const live = many(PAGE_SIZE + 2, { archivedAt: null });
    const archived = [makeThread({ id: "arch", archivedAt: 1, updatedAt: 1 })];
    const view = paginate(sortThreads([...live, ...archived]), false);
    expect(view.label).toBe("load-more");
  });
});

describe("status derivation", () => {
  test("statusDot passes through the four-state thread status", () => {
    expect(statusDot(makeThread({ status: "idle" }))).toBe("idle");
    expect(statusDot(makeThread({ status: "running" }))).toBe("running");
    expect(statusDot(makeThread({ status: "unread" }))).toBe("unread");
    expect(statusDot(makeThread({ status: "failed" }))).toBe("failed");
  });

  test("idle has no dot metadata", () => {
    expect(statusMeta("idle")).toBeNull();
  });

  test("running / unread / failed each have distinct class + label", () => {
    const running = statusMeta("running");
    const unread = statusMeta("unread");
    const failed = statusMeta("failed");
    expect(running).not.toBeNull();
    expect(unread).not.toBeNull();
    expect(failed).not.toBeNull();
    const classes = [running?.className, unread?.className, failed?.className];
    expect(new Set(classes).size).toBe(3);
    const labels = [running?.label, unread?.label, failed?.label];
    expect(new Set(labels).size).toBe(3);
  });
});

describe("threadTitle", () => {
  test("falls back to the New conversation placeholder when null", () => {
    expect(threadTitle(makeThread({ title: null }))).toBe(UNTITLED_PLACEHOLDER);
    expect(UNTITLED_PLACEHOLDER).toBe("New conversation");
  });

  test("uses the title when present", () => {
    expect(threadTitle(makeThread({ title: "My chat" }))).toBe("My chat");
  });
});
