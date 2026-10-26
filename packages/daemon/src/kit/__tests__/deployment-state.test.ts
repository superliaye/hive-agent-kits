import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(state.read(key, "codex")?.applied?.operationId).toBe("op-1");
    state.recordFailure(
      key,
      "codex",
      { action: "update", code: "io", detail: "write failed" },
      "op-2",
    );
    expect(state.read(key, "codex")?.applied).toEqual({ ...appliedV1, operationId: "op-1" });
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
    expect(record?.applied).toEqual({ ...appliedV1, operationId: "op-1" });
    expect(record?.lastAttempt.outcome).toBe("failed");
    expect(record?.lastAttempt.detail).not.toContain("super-secret");
    expect(record?.lastAttempt.detail).not.toContain("/private/path");
    expect(record?.lastAttempt.detail?.length ?? 0).toBeLessThanOrEqual(512);
  });

  test("replayed interruption marking is idempotent for the same operation action", () => {
    let clock = 100;
    const state = openDeploymentStateStore(path, { now: () => clock });
    const first = state.markInterrupted(key, "claude", "add", "operation-recovery");
    const revision = state.readAll().revision;
    clock = 200;

    const replay = state.markInterrupted(key, "claude", "add", "operation-recovery");

    expect(replay).toEqual(first);
    expect(state.readAll().revision).toBe(revision);
    expect(replay.lastAttempt.attemptedAt).toBe(100);
  });

  test("bounds interruption replay receipts", () => {
    const state = openDeploymentStateStore(path, { interruptionReceiptRetention: 2 });
    state.markInterrupted(key, "claude", "add", "operation-1");
    state.markInterrupted(key, "claude", "add", "operation-2");
    state.markInterrupted(key, "claude", "add", "operation-3");

    expect(state.readAll().interruptionReceipts?.map((receipt) => receipt.operationId)).toEqual([
      "operation-2",
      "operation-3",
    ]);
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
    expect(() => partial.recordRemoval(key, "claude", "op-2")).toThrow(
      "deployment_state_write_failed",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("redacts complete bearer credentials and filesystem paths", () => {
    const state = openDeploymentStateStore(path);
    state.recordFailure(
      key,
      "claude",
      {
        action: "add",
        code: "io",
        detail: "Authorization: Bearer token.secret-value EACCES: /private/user/.hive/state.json",
      },
      "op-redacted",
    );
    const detail = state.read(key, "claude")?.lastAttempt.detail ?? "";
    expect(detail).not.toContain("token.secret-value");
    expect(detail).not.toContain("/private/user/.hive/state.json");
  });

  test("serializes real concurrent writers without dropping either outcome", async () => {
    const moduleUrl = new URL("../deployment-state.ts", import.meta.url).href;
    const worker = (name: string) =>
      Bun.spawn({
        cmd: [
          "bun",
          "-e",
          `import { openDeploymentStateStore } from ${JSON.stringify(moduleUrl)};
           const store = openDeploymentStateStore(process.argv.at(-2));
           store.recordFailure({ kind: "skill", name: process.argv.at(-1) }, "claude", { action: "add", code: "io", detail: "write failed" }, process.argv.at(-1));`,
          path,
          name,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = worker("first");
    const second = worker("second");
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    const file = openDeploymentStateStore(path).readAll();
    expect(file.records.map((record) => record.key.name).sort()).toEqual(["first", "second"]);
    expect(file.revision).toBe(2);
  });

  test("recovers after a writer is killed while holding the state lock", async () => {
    const moduleUrl = new URL("../deployment-state.ts", import.meta.url).href;
    const writer = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `import { openDeploymentStateStore } from ${JSON.stringify(moduleUrl)};
         openDeploymentStateStore(process.env.STATE_PATH, {
           rename: () => process.kill(process.pid, "SIGKILL"),
         }).recordFailure(
           { kind: "skill", name: "crashed" },
           "claude",
           { action: "add", code: "io", detail: "write failed" },
           "crashed-op",
         );`,
      ],
      env: { ...process.env, STATE_PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await writer.exited).not.toBe(0);

    const recovered = openDeploymentStateStore(path, { lockTimeoutMs: 100 });
    expect(() =>
      recovered.recordFailure(
        key,
        "claude",
        { action: "add", code: "io", detail: "write failed" },
        "recovered-op",
      ),
    ).not.toThrow();
    expect(recovered.read(key, "claude")?.lastAttempt.operationId).toBe("recovered-op");
  });

  test("redacts Windows drive paths with spaces and UNC paths", () => {
    const state = openDeploymentStateStore(path);
    state.recordFailure(
      key,
      "claude",
      {
        action: "add",
        code: "io",
        detail:
          "EACCES C:\\Users\\Jane Doe\\Hive State\\state.json and \\\\server\\team share\\secret.txt",
      },
      "op-windows",
    );
    const detail = state.read(key, "claude")?.lastAttempt.detail ?? "";
    expect(detail).not.toContain("C:\\Users\\Jane Doe\\Hive State\\state.json");
    expect(detail).not.toContain("\\\\server\\team share\\secret.txt");
  });

  test("converts inaccessible-parent errors to a stable path-free code", () => {
    const inaccessible = openDeploymentStateStore("/dev/null/deployment-state.json");
    expect(() =>
      inaccessible.recordFailure(key, "claude", { action: "add", code: "io", detail: "x" }, "op"),
    ).toThrow("deployment_state_lock_failed");
  });
});
