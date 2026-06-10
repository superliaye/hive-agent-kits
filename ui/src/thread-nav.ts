// thread-nav — pure functional core for the chat left-nav. No React, no fetch.
// Mirrors the editing-session.ts pattern: a data record plus pure verbs, with
// the React/EventSource wiring living in ChatPage on top.
//
// Responsibilities: group threads by agent, sort within a group
// (non-archived first, then archived; each bucket newest-interaction first),
// paginate (top-N with a Load-more / Load-archived affordance), order the
// groups deterministically, and derive the per-row status indicator.

import type { ThreadSummary } from "./api.ts";

export const PAGE_SIZE = 20;

// The /api/events SSE wire names ChatPage subscribes to for live status-dot
// updates. The daemon names each frame `${source}.${type}`; run envelopes have
// source "run" and type "run.<verb>", so the wire name is double-prefixed
// (`run.run.started` etc. — the daemon side is pinned in
// routes-threads-runs.test.ts). This non-obvious double-prefix is a regression
// footgun; thread-nav.run-wire.test.ts guards the names against drift.
export const RUN_WIRE_EVENTS = [
  "run.run.started",
  "run.run.completed",
  "run.run.failed",
  "run.run.cancelled",
] as const;

// ─── Grouping ────────────────────────────────────────────────────────────

// Group threads by agentId, each group internally sorted (see sortThreads).
// Group order is deterministic: by the most-recent interaction of any thread
// in the group, descending (newest-active agent first), then agentId asc as a
// stable tiebreak.
export function groupByAgent(threads: readonly ThreadSummary[]): Array<{
  agentId: string;
  threads: ThreadSummary[];
}> {
  const byAgent = new Map<string, ThreadSummary[]>();
  for (const t of threads) {
    const bucket = byAgent.get(t.agentId);
    if (bucket) bucket.push(t);
    else byAgent.set(t.agentId, [t]);
  }

  const groups = Array.from(byAgent, ([agentId, list]) => ({
    agentId,
    threads: sortThreads(list),
  }));

  groups.sort((a, b) => {
    const recencyDelta = groupRecency(b.threads) - groupRecency(a.threads);
    if (recencyDelta !== 0) return recencyDelta;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  });
  return groups;
}

// Most-recent interaction within a group (max updatedAt). Empty groups never
// occur (a group exists only because a thread put it there), but guard anyway.
function groupRecency(threads: readonly ThreadSummary[]): number {
  let max = 0;
  for (const t of threads) if (t.updatedAt > max) max = t.updatedAt;
  return max;
}

// ─── Sorting ─────────────────────────────────────────────────────────────

// Non-archived first, then archived; within each bucket by last interaction
// (updatedAt) descending. Pure — returns a new array.
export function sortThreads(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    const aArchived = a.archivedAt !== null;
    const bArchived = b.archivedAt !== null;
    if (aArchived !== bArchived) return aArchived ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });
}

// ─── Pagination ──────────────────────────────────────────────────────────

// What the Load-more control should say (or that it should be hidden):
//   - "none":         everything visible, no control.
//   - "load-more":    hidden rows include non-archived threads.
//   - "load-archived": the only hidden rows are archived.
export type LoadMoreLabel = "none" | "load-more" | "load-archived";

export type PageView = {
  visible: ThreadSummary[];
  label: LoadMoreLabel;
};

// Paginate one already-sorted group. `expanded` reveals the full list
// (including archived). When collapsed, show the first PAGE_SIZE rows; the
// label distinguishes "more non-archived hidden" from "only archived hidden"
// so the control can read "Load archived" in the latter case.
export function paginate(sorted: readonly ThreadSummary[], expanded: boolean): PageView {
  if (expanded || sorted.length <= PAGE_SIZE) {
    return { visible: [...sorted], label: "none" };
  }
  const visible = sorted.slice(0, PAGE_SIZE);
  const hidden = sorted.slice(PAGE_SIZE);
  const anyHiddenNonArchived = hidden.some((t) => t.archivedAt === null);
  return { visible, label: anyHiddenNonArchived ? "load-more" : "load-archived" };
}

// ─── Status derivation ───────────────────────────────────────────────────

// The four distinct nav indicators. `idle` renders no dot.
export type StatusDot = "running" | "unread" | "failed" | "idle";

const STATUS_META: Record<StatusDot, { label: string; className: string } | null> = {
  running: { label: "Running", className: "status-running" },
  unread: { label: "Unread", className: "status-unread" },
  failed: { label: "Failed", className: "status-failed" },
  idle: null,
};

export function statusDot(thread: ThreadSummary): StatusDot {
  return thread.status;
}

// Visual metadata for a status, or null for idle (no dot rendered).
export function statusMeta(status: StatusDot): { label: string; className: string } | null {
  return STATUS_META[status];
}

// ─── Title ───────────────────────────────────────────────────────────────

export const UNTITLED_PLACEHOLDER = "New conversation";

export function threadTitle(thread: ThreadSummary): string {
  return thread.title ?? UNTITLED_PLACEHOLDER;
}
