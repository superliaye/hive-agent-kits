import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalDescriptor, resolveShellLaunch } from "./connection.ts";

const roots: string[] = [];
const now = 1_800_000_000_000;

function validDescriptor() {
  return {
    version: 1,
    baseUrl: "http://127.0.0.1:43117",
    displayName: "Arca",
    expected: {
      protocolRange: "1",
      daemonInstanceId: "018f7f7a-1234-7abc-8def-0123456789ab",
      runtimeRootId: "runtime-root-id-1234567890",
      buildVersion: "0.0.0",
    },
    session: {
      sessionId: "018f7f7a-2234-7abc-8def-0123456789ab",
      sessionToken: "a".repeat(43),
      expiresAt: now + 60_000,
    },
  };
}

function writeDescriptor(body: unknown, mode = 0o600): string {
  const root = mkdtempSync(join(tmpdir(), "hive-connection-"));
  roots.push(root);
  const path = join(root, "connection.json");
  writeFileSync(path, JSON.stringify(body), { mode });
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external connection descriptor", () => {
  test("loads an owner-only descriptor exactly once", () => {
    const path = writeDescriptor(validDescriptor());

    const connection = loadExternalDescriptor(path, { now: () => now });

    expect(connection.kind).toBe("external");
    expect(connection.displayName).toBe("Arca");
    expect(connection.session.sessionToken).toBe("a".repeat(43));
    expect(existsSync(path)).toBe(false);
  });

  test("rejects loose permissions and still consumes the descriptor", () => {
    const path = writeDescriptor(validDescriptor(), 0o644);

    expect(() => loadExternalDescriptor(path, { now: () => now })).toThrow("owner-only");
    expect(existsSync(path)).toBe(false);
  });

  test("rejects an expired external session", () => {
    const body = validDescriptor();
    body.session.expiresAt = now;
    const path = writeDescriptor(body);

    expect(() => loadExternalDescriptor(path, { now: () => now })).toThrow("expired");
    expect(existsSync(path)).toBe(false);
  });

  test("rejects launch when the one-shot descriptor cannot be consumed", () => {
    const path = writeDescriptor(validDescriptor());

    expect(() =>
      loadExternalDescriptor(path, {
        now: () => now,
        unlink: () => {
          const error = new Error("read-only parent") as Error & { code: string };
          error.code = "EACCES";
          throw error;
        },
      }),
    ).toThrow("could not be consumed");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(path, "..")).some((name) => name.startsWith(".hive-descriptor-"))).toBe(
      true,
    );
  });

  test("fails closed before reading a descriptor on Windows", () => {
    const path = writeDescriptor(validDescriptor());

    expect(() => loadExternalDescriptor(path, { now: () => now, platform: "win32" })).toThrow(
      "unsupported on Windows",
    );
    expect(existsSync(path)).toBe(true);
  });

  test("rejects a descriptor symlink without consuming its target", () => {
    const target = writeDescriptor(validDescriptor());
    const link = join(target, "..", "connection-link.json");
    symlinkSync(target, link);

    expect(() => loadExternalDescriptor(link, { now: () => now })).toThrow("owner-only");
    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("rejects malformed or repeated reserved launch flags", () => {
    for (const argv of [
      ["--hive-external-descriptor"],
      ["--hive-external-descriptor="],
      ["--hive-external-descriptor-other=value"],
      ["--hive-external-descriptor=one", "--hive-external-descriptor=two"],
    ]) {
      expect(() => resolveShellLaunch(argv, { now: () => now })).toThrow();
    }
  });

  test("resolves managed and external launch modes without fallback", () => {
    expect(resolveShellLaunch([], { now: () => now })).toEqual({ kind: "managed" });
    const path = writeDescriptor(validDescriptor());
    expect(
      resolveShellLaunch(["Hive", `--hive-external-descriptor=${path}`], { now: () => now }),
    ).toMatchObject({ kind: "external", displayName: "Arca" });
  });
});
