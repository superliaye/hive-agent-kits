import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeploymentApplied, openDeploymentStateStore } from "../deployment-state.ts";

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deployment-state-"));
  path = join(root, "kit", "deployment-state.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const key = { kind: "skill" as const, name: "alpha" };
const appliedV1: DeploymentApplied = {
  sourceId: "source-a",
  contentSha: "a".repeat(64),
  renderedHash: "b".repeat(64),
  appliedAt: 100,
};

describe("DeploymentStateStore", () => {
  test("persists revisioned success, preserves applied through failure, and clears only on removal", () => {
    const state = openDeploymentStateStore(path, { now: () => 100 });
    state.recordSuccess(key, "codex", appliedV1, "op-1");
    state.recordFailure(
      key,
      "codex",
      { action: "update", code: "io", detail: "write failed" },
      "op-2",
    );
    expect(state.read(key, "codex")?.applied).toEqual(appliedV1);
    expect(state.read(key, "codex")?.lastAttempt).toMatchObject({
      action: "update",
      outcome: "failed",
      operationId: "op-2",
    });
    state.recordRemoval(key, "codex", "op-3");
    expect(state.read(key, "codex")?.applied).toBeUndefined();
    expect(state.read(key, "codex")?.lastAttempt).toMatchObject({
      action: "remove",
      outcome: "succeeded",
    });
    expect(state.readAll().revision).toBe(3);
    expect(openDeploymentStateStore(path).readAll().revision).toBe(3);
  });

  test("current-version corruption fails visibly rather than reseeding", () => {
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(path, '{"schemaVersion":1,"revision":');
    expect(() => openDeploymentStateStore(path).readAll()).toThrow("deployment_state_corrupt");
  });

  test("redacts and bounds semantic failure detail and interruption retains applied", () => {
    const state = openDeploymentStateStore(path, { now: () => 100 });
    state.recordSuccess(key, "claude", appliedV1, "op-1");
    state.markInterrupted(key, "claude", "update", "op-2");
    state.recordFailure(
      key,
      "claude",
      {
        action: "update",
        code: "io",
        detail: `token=super-secret /private/path ${"x".repeat(800)}`,
      },
      "op-3",
    );
    const record = state.read(key, "claude");
    expect(record?.applied).toEqual(appliedV1);
    expect(record?.lastAttempt.outcome).toBe("failed");
    expect(record?.lastAttempt.detail).not.toContain("super-secret");
    expect(record?.lastAttempt.detail).not.toContain("/private/path");
    expect(record?.lastAttempt.detail?.length ?? 0).toBeLessThanOrEqual(512);
  });

  test("retains the previous file when a partial temporary write cannot complete", () => {
    const stable = openDeploymentStateStore(path, { now: () => 100 });
    stable.recordSuccess(key, "claude", appliedV1, "op-1");
    const before = readFileSync(path, "utf8");
    const partial = openDeploymentStateStore(path, {
      write: (_fd, _bytes, _offset, length) => Math.min(1, length),
      now: () => 101,
      rename: () => {
        throw new Error("rename failed");
      },
    });
    expect(() => partial.recordRemoval(key, "claude", "op-2")).toThrow("rename failed");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("imports legacy fingerprint provenance into applied state once", () => {
    const legacy = join(root, "kit", "fingerprints.json");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        entries: [
          {
            kind: "skill",
            name: "alpha",
            target: "claude",
            hash: "c".repeat(64),
            deployedAt: 77,
            winnerSourceId: "source-a",
          },
        ],
      }),
    );
    const state = openDeploymentStateStore(path, { legacyFingerprintPath: legacy });
    expect(state.read(key, "claude")?.applied).toMatchObject({
      sourceId: "source-a",
      contentSha: null,
      renderedHash: "c".repeat(64),
      appliedAt: 77,
    });
    expect(existsSync(path)).toBe(true);
  });
});
