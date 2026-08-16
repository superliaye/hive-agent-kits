import { describe, expect, test } from "bun:test";
import {
  deploymentActiveFromOverview,
  shouldConfirmShellClose,
  shouldDrainShellDaemon,
  shouldManageDaemon,
  shouldQuitAfterAllWindowsClosed,
} from "./lifecycle.ts";

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

  test("external mode quits after its last macOS window closes", () => {
    expect(shouldQuitAfterAllWindowsClosed("external", "darwin")).toBe(true);
    expect(shouldQuitAfterAllWindowsClosed("managed", "darwin")).toBe(false);
    expect(shouldQuitAfterAllWindowsClosed("managed", "linux")).toBe(true);
  });

  test("prompts only when durable Overview confirms an active Deploy", () => {
    expect(deploymentActiveFromOverview(200, '{"activeOperation":null}')).toBe(false);
    expect(
      deploymentActiveFromOverview(
        200,
        '{"activeOperation":{"operationId":"operation-1","state":"running"}}',
      ),
    ).toBe(true);
    expect(deploymentActiveFromOverview(500, "unavailable")).toBe(false);
    expect(deploymentActiveFromOverview(200, "not-json")).toBe(false);
  });
});
