// Close-during-deploy guard predicate (Feature 3) — unit tests for the pure
// decision. The dialog itself is manual; this predicate is the testable core.

import { describe, expect, test } from "bun:test";
import { hasDaemonToDrain, shouldConfirmClose } from "./close-guard.ts";

describe("shouldConfirmClose", () => {
  test("confirms while a deploy is in flight and not yet confirmed", () => {
    expect(shouldConfirmClose(true, false)).toBe(true);
  });

  test("does NOT confirm when no deploy is in flight", () => {
    expect(shouldConfirmClose(false, false)).toBe(false);
  });

  test("does NOT re-confirm once the user already chose Close anyway", () => {
    // The second before-quit pass (and any later pass) this quit cycle falls
    // straight through to the daemon drain — no repeated dialog.
    expect(shouldConfirmClose(true, true)).toBe(false);
  });

  test("idle + already-confirmed is still no-confirm", () => {
    expect(shouldConfirmClose(false, true)).toBe(false);
  });
});

describe("hasDaemonToDrain", () => {
  test("true when the shell owns a live daemon (packaged path)", () => {
    expect(
      hasDaemonToDrain({ hasDaemon: true, spawnedByShell: true, daemonKilled: false }),
    ).toBe(true);
  });

  test("false when no daemon handle (dev path: daemon spawned separately)", () => {
    // Regression guard: after the close-anyway confirm preventDefaults the quit,
    // a false here tells main.ts to re-issue app.quit() instead of hanging open.
    expect(
      hasDaemonToDrain({ hasDaemon: false, spawnedByShell: false, daemonKilled: true }),
    ).toBe(false);
  });

  test("false when a daemon exists but the shell didn't spawn it", () => {
    expect(
      hasDaemonToDrain({ hasDaemon: true, spawnedByShell: false, daemonKilled: false }),
    ).toBe(false);
  });

  test("false when the daemon is already killed", () => {
    expect(
      hasDaemonToDrain({ hasDaemon: true, spawnedByShell: true, daemonKilled: true }),
    ).toBe(false);
  });
});
