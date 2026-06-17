// Derived thread status — a pure function over the thread's run state and
// last-read mark. No coupling to Runs or the store: the caller (Phase 2 wiring)
// supplies `isBusy` (from the executor's in-flight set), the thread's newest
// terminal Run, and the thread's `lastReadAt`. Status is the Thread's property;
// the busy predicate lives on the executor (it owns the in-flight set).

export type ThreadStatus = "idle" | "running" | "unread" | "failed";

export type DeriveThreadStatusInput = {
  isBusy: boolean;
  // The thread's newest terminal (non-running) Run by `endedAt`, or null when
  // none. A single scan keyed on `endedAt` — the newest terminal row wins, so a
  // newer completed Run beats an older failed/cancelled one.
  newestTerminal: {
    status: "completed" | "failed" | "cancelled";
    endedAt: number;
  } | null;
  lastReadAt: number | null;
};

// Precedence: running > failed > unread > idle.
//   1. An in-flight Run wins → running.
//   2. Else the newest terminal Run failed or was cancelled and is unseen
//      (never read, or it ended after last-read) → failed. Clears on read.
//   3. Else the newest terminal Run completed and is unseen → unread.
//   4. Else → idle.
export function deriveThreadStatus(input: DeriveThreadStatusInput): ThreadStatus {
  const { isBusy, newestTerminal, lastReadAt } = input;
  if (isBusy) return "running";
  if (newestTerminal === null) return "idle";
  const unseen = lastReadAt === null || newestTerminal.endedAt > lastReadAt;
  if (!unseen) return "idle";
  if (newestTerminal.status === "failed" || newestTerminal.status === "cancelled") return "failed";
  return "unread";
}
