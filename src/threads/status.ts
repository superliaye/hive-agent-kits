// Derived thread status — a pure function of three scalars. No coupling to
// Runs or the store: the caller (Phase 2 wiring) supplies `isBusy` (from the
// executor's in-flight set), the newest completed Run's `endedAt`, and the
// thread's `lastReadAt`. Status is the Thread's property; the busy predicate
// lives on the executor (it owns the in-flight set).

export type ThreadStatus = "idle" | "running" | "unread";

export type DeriveThreadStatusInput = {
  isBusy: boolean;
  newestCompletedEndedAt: number | null;
  lastReadAt: number | null;
};

// Precedence: an in-flight Run wins (running). Otherwise the thread is unread
// when its newest completed Run finished after the last read — including the
// never-read case (lastReadAt === null) with at least one completed Run.
// Everything else is idle.
export function deriveThreadStatus(input: DeriveThreadStatusInput): ThreadStatus {
  const { isBusy, newestCompletedEndedAt, lastReadAt } = input;
  if (isBusy) return "running";
  if (
    newestCompletedEndedAt !== null &&
    (lastReadAt === null || newestCompletedEndedAt > lastReadAt)
  ) {
    return "unread";
  }
  return "idle";
}
