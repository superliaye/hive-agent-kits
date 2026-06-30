import { describe, expect, test } from "bun:test";
import {
  canReuseReadyDaemon,
  incompatibleDaemonMessage,
  parseReadyProbe,
} from "./daemon-ready.ts";

describe("daemon ready compatibility", () => {
  test("packaged shell accepts a packaged real-home daemon", () => {
    const probe = parseReadyProbe(true, {
      status: "ok",
      daemonMode: "packaged",
      deployTargetMode: "real",
    });

    expect(canReuseReadyDaemon("packaged", probe)).toBe(true);
  });

  test("packaged shell rejects a dev sandbox daemon", () => {
    const probe = parseReadyProbe(true, {
      status: "ok",
      daemonMode: "dev",
      deployTargetMode: "sandbox",
    });

    expect(canReuseReadyDaemon("packaged", probe)).toBe(false);
    expect(incompatibleDaemonMessage(probe)).toContain("daemonMode=dev");
  });

  test("packaged shell rejects a legacy ready response without metadata", () => {
    const probe = parseReadyProbe(true, { status: "ok" });

    expect(canReuseReadyDaemon("packaged", probe)).toBe(false);
    expect(incompatibleDaemonMessage(probe)).toContain("did not expose compatibility metadata");
  });

  test("dev shell can reuse any ready daemon", () => {
    const legacyProbe = parseReadyProbe(true, { status: "ok" });

    expect(canReuseReadyDaemon("dev", legacyProbe)).toBe(true);
  });

  test("no shell can reuse a non-ready daemon", () => {
    const probe = parseReadyProbe(false, null);

    expect(canReuseReadyDaemon("dev", probe)).toBe(false);
    expect(canReuseReadyDaemon("packaged", probe)).toBe(false);
  });
});
