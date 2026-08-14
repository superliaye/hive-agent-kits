import { describe, expect, test } from "bun:test";
import {
  canReuseReadyDaemon,
  incompatibleDaemonMessage,
  parseReadyProbe,
  validateExternalReady,
} from "./daemon-ready.ts";

const metadata = {
  status: "ok" as const,
  protocolVersion: 1 as const,
  buildVersion: "0.0.0",
  daemonInstanceId: "018f7f7a-1234-7abc-8def-0123456789ab",
  runtimeRootId: "runtime-root-id-1234567890",
  daemonMode: "packaged" as const,
  deployTargetMode: "real" as const,
};

const descriptor = {
  version: 1 as const,
  baseUrl: "http://127.0.0.1:43117",
  displayName: "Arca",
  expected: {
    protocolRange: "1" as const,
    daemonInstanceId: metadata.daemonInstanceId,
    runtimeRootId: metadata.runtimeRootId,
    buildVersion: metadata.buildVersion,
  },
  session: {
    sessionId: "018f7f7a-2234-7abc-8def-0123456789ab",
    sessionToken: "a".repeat(43),
    expiresAt: 4_000_000_000_000,
  },
};

describe("daemon ready compatibility", () => {
  test("packaged shell accepts a packaged real-home daemon", () => {
    const probe = parseReadyProbe(true, {
      ...metadata,
    });

    expect(canReuseReadyDaemon("packaged", probe)).toBe(true);
  });

  test("packaged shell rejects a dev sandbox daemon", () => {
    const probe = parseReadyProbe(true, {
      ...metadata,
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

  test("external compatibility requires exact daemon and runtime identity", () => {
    expect(validateExternalReady(descriptor, metadata)).toEqual({ ok: true });
    expect(
      validateExternalReady(descriptor, {
        ...metadata,
        daemonInstanceId: "018f7f7a-3234-7abc-8def-0123456789ab",
      }),
    ).toEqual({
      ok: false,
      message: "external daemon instance does not match the connection descriptor",
    });
    expect(validateExternalReady(descriptor, { ...metadata, deployTargetMode: "sandbox" })).toEqual({
      ok: false,
      message: "external daemon is not configured for real deployment targets",
    });
  });
});
