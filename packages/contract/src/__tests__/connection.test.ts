import { describe, expect, test } from "bun:test";
import {
  DAEMON_PROTOCOL_VERSION,
  ExternalConnectionDescriptor,
  ReadyResponse,
  ShellConnectionMetadata,
} from "../connection.ts";

const instanceId = "018f7f7a-1234-7abc-8def-0123456789ab";

function descriptor(baseUrl = "http://127.0.0.1:43117") {
  return {
    version: 1,
    baseUrl,
    displayName: "Arca",
    expected: {
      protocolRange: "1",
      daemonInstanceId: instanceId,
      runtimeRootId: "runtime-root-id-1234567890",
      buildVersion: "0.0.0",
    },
    session: {
      sessionId: "018f7f7a-2234-7abc-8def-0123456789ab",
      sessionToken: "a".repeat(43),
      expiresAt: 4_000_000_000_000,
    },
  };
}

describe("external connection contract", () => {
  test("accepts a versioned loopback descriptor", () => {
    expect(ExternalConnectionDescriptor.parse(descriptor()).version).toBe(1);
  });

  test("rejects non-loopback and credential-bearing endpoints", () => {
    expect(ExternalConnectionDescriptor.safeParse(descriptor("https://arca.example")).success).toBe(
      false,
    );
    expect(
      ExternalConnectionDescriptor.safeParse(descriptor("http://user:secret@127.0.0.1:43117"))
        .success,
    ).toBe(false);
  });

  test("separates daemon protocol metadata from descriptor version", () => {
    const ready = ReadyResponse.parse({
      status: "ok",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      buildVersion: "0.0.0",
      daemonInstanceId: instanceId,
      runtimeRootId: "runtime-root-id-1234567890",
      daemonMode: "packaged",
      deployTargetMode: "real",
      activeExternalSessions: 2,
    });

    expect(ready.protocolVersion).toBe(1);
    expect(ready.activeExternalSessions).toBe(2);
  });

  test("rejects a negative external session count", () => {
    expect(
      ReadyResponse.safeParse({
        status: "ok",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        buildVersion: "0.0.0",
        daemonInstanceId: instanceId,
        runtimeRootId: "runtime-root-id-1234567890",
        daemonMode: "packaged",
        deployTargetMode: "real",
        activeExternalSessions: -1,
      }).success,
    ).toBe(false);
  });

  test("represents external sessions that require relaunch authentication", () => {
    expect(
      ShellConnectionMetadata.parse({
        kind: "external",
        displayName: "Arca",
        status: "reauthentication_required",
      }).status,
    ).toBe("reauthentication_required");
  });
});
