import { describe, expect, test } from "bun:test";
import { shouldConfirmShellClose, shouldDrainShellDaemon, shouldManageDaemon } from "./lifecycle.ts";

describe("Shell launch lifecycle", () => {
  test("managed mode owns the local Daemon lifecycle", () => {
    expect(shouldManageDaemon("managed")).toBe(true);
    expect(shouldConfirmShellClose("managed", true, false)).toBe(true);
    expect(
      shouldDrainShellDaemon("managed", {
        hasDaemon: true,
        spawnedByShell: true,
        daemonKilled: false,
      }),
    ).toBe(true);
  });

  test("external mode never confirms, drains, or kills a local Daemon", () => {
    expect(shouldManageDaemon("external")).toBe(false);
    expect(shouldConfirmShellClose("external", true, false)).toBe(false);
    expect(
      shouldDrainShellDaemon("external", {
        hasDaemon: true,
        spawnedByShell: true,
        daemonKilled: false,
      }),
    ).toBe(false);
  });
});
