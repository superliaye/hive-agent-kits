// Auto-archive boot sweep. A thread idle (no new message) for longer than
// AUTO_ARCHIVE_IDLE_DAYS is archived automatically. This is system-initiated,
// not a user action → it writes a TRACE line per archived thread and produces
// NO audit row: it calls the store's non-emitting `archive(id, "auto")` path
// (only `archive(id, "manual")` emits `thread.archived`).
//
// Idle is measured against `updated_at` (the last-message sort key), so a
// thread the user is still talking to never trips the sweep. Auto-archive does
// NOT bump `updated_at` (the store's archive verb only sets `archived_at`).

import { log } from "../lib/log.ts";
import type { ThreadsStore } from "./store.ts";

export const AUTO_ARCHIVE_IDLE_DAYS = 60;
export const AUTO_ARCHIVE_IDLE_MS = AUTO_ARCHIVE_IDLE_DAYS * 24 * 60 * 60 * 1000;

// Archives every active thread whose last interaction predates the idle cutoff.
// `now` is injectable for tests. Safe on an empty DB (the query returns []).
export async function autoArchiveSweep(
  threads: ThreadsStore,
  now: () => number = Date.now,
): Promise<void> {
  const cutoff = now() - AUTO_ARCHIVE_IDLE_MS;
  const stale = threads.listActiveIdleBefore(cutoff);
  for (const thread of stale) {
    await threads.archive(thread.id, "auto");
    log().info(
      { module: "threads/auto-archive", threadId: thread.id, updatedAt: thread.updatedAt },
      "auto-archived idle thread",
    );
  }
}
