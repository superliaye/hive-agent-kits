import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import type { SkillFile } from "../deploy/transforms.ts";
import {
  type DeployOperationStore,
  openDeployOperationStore,
  type StagedDeployPayload,
  stagedFile,
} from "../deploy-operations.ts";
import type { DeployPlan } from "../deploy-plan.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function operationPath(): string {
  const root = mkdtempSync(join(tmpdir(), "deploy-operations-"));
  roots.push(root);
  return join(root, "operations.json");
}

const blobDirectory = (path: string) => join(path, "..", "operations.blobs");
const payloadDirectory = (path: string) => join(path, "..", "operations.payloads");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function plan(): DeployPlan {
  return {
    selectionRevision: 7,
    sourceRegistryRevision: 3,
    mirrors: [{ sourceId: "source-a", precedence: 1, identity: "mirror-a" }],
    ledger: { revision: null, identity: "ledger-a" },
    deploymentStateRevision: 2,
    actions: [
      {
        action: "add",
        key: { kind: "skill", name: "alpha" },
        target: "claude",
        sourceId: "source-a",
        contentSha: "a".repeat(64),
        renderedHash: "b".repeat(64),
        artifact: { existence: "missing", hash: null },
      },
    ],
    instructionWrites: [],
    blocked: [],
    satisfiedRemovalIntents: [],
  };
}

const text = (rel: string, body: string): SkillFile => ({
  rel,
  mode: 0o644,
  bytes: new TextEncoder().encode(body),
});

function skillPayload(
  files: readonly SkillFile[],
  targets: readonly DeployTarget[] = ["claude", "codex"],
): StagedDeployPayload {
  return {
    tasks: targets.map((target) => ({
      type: "skill",
      action: "add",
      key: { kind: "skill", name: "alpha" },
      target,
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash: "b".repeat(64),
      files: files.map(stagedFile),
    })),
    metadata: {},
  };
}

function complete(store: DeployOperationStore, operationId: string, staged: StagedDeployPayload) {
  store.createQueued({
    operationId,
    acceptedAt: 1,
    selectionRevision: 7,
    planToken: "token",
    plan: plan(),
    staged,
  });
  store.markRunning(operationId);
  store.finish(operationId, "completed");
}

describe("deploy operation blob store", () => {
  test("stores each distinct file body once across targets and operations", () => {
    const path = operationPath();
    const store = openDeployOperationStore(path, { now: () => 10 });
    const binary: SkillFile = { rel: "logo.png", mode: 0o755, bytes: new Uint8Array([0, 255, 1]) };
    const first = skillPayload([text("SKILL.md", "shared body\n"), binary]);
    const second = skillPayload([text("SKILL.md", "shared body\n"), text("notes.md", "new\n")]);

    complete(store, "first", first);
    complete(store, "second", second);

    expect(readdirSync(blobDirectory(path)).sort()).toEqual(
      [sha256("shared body\n"), sha256(binary.bytes), sha256("new\n")].sort(),
    );
    for (const entry of readdirSync(payloadDirectory(path))) {
      expect(readFileSync(join(payloadDirectory(path), entry), "utf8")).not.toContain(
        "shared body",
      );
    }
    expect(store.read("first")?.staged).toEqual(first);
    expect(store.read("second")?.staged).toEqual(second);
  });

  test("garbage-collects only the blobs no retained operation references", () => {
    const path = operationPath();
    const store = openDeployOperationStore(path, { now: () => 10, payloadRetention: 1 });

    complete(store, "first", skillPayload([text("a.md", "only first\n"), text("b.md", "both\n")]));
    expect(readdirSync(blobDirectory(path))).toHaveLength(2);
    complete(
      store,
      "second",
      skillPayload([text("b.md", "both\n"), text("c.md", "only second\n")]),
    );

    expect(store.read("first")).toBeUndefined();
    expect(readdirSync(blobDirectory(path)).sort()).toEqual(
      [sha256("both\n"), sha256("only second\n")].sort(),
    );
    expect(openDeployOperationStore(path).read("second")?.staged.tasks).toHaveLength(2);
  });

  test("a crash between the blob writes and the payload write leaves the store loadable", async () => {
    const path = operationPath();
    const moduleUrl = new URL("../deploy-operations.ts", import.meta.url).href;
    const queued = {
      operationId: "crashed",
      acceptedAt: 1,
      selectionRevision: 7,
      planToken: "token",
      plan: plan(),
      staged: skillPayload([text("SKILL.md", "body\n")]),
    };
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { renameSync } from "node:fs";
const { openDeployOperationStore } = await import(process.env.OP_MODULE_URL);
const store = openDeployOperationStore(process.env.OP_PATH, {
  rename: (from, to) => {
    if (to.includes(".payloads")) process.kill(process.pid, "SIGKILL");
    renameSync(from, to);
  },
});
store.createQueued(JSON.parse(process.env.OP_INPUT));`,
      ],
      {
        env: {
          ...process.env,
          OP_MODULE_URL: moduleUrl,
          OP_PATH: path,
          OP_INPUT: JSON.stringify(queued),
        },
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(readdirSync(blobDirectory(path))).toEqual([sha256("body\n")]);

    const reopened = openDeployOperationStore(path);

    expect(reopened.list()).toEqual([]);
    expect(readdirSync(blobDirectory(path))).toEqual([]);
    expect(readdirSync(payloadDirectory(path))).toEqual([]);
    reopened.createQueued(queued);
    expect(reopened.read("crashed")?.staged).toEqual(queued.staged);
  });

  test("loads a payload that inlines skill file content", () => {
    const path = operationPath();
    const operationId = "inline";
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        operations: [
          {
            operationId,
            state: "completed",
            acceptedAt: 1,
            completedAt: 2,
            selectionRevision: 7,
            planToken: "token",
            executionPhase: "finished",
          },
        ],
      }),
    );
    mkdirSync(payloadDirectory(path), { recursive: true });
    const inline = {
      operationId,
      plan: plan(),
      staged: {
        tasks: [
          {
            ...skillPayload([], ["claude"]).tasks[0],
            files: [
              { rel: "SKILL.md", content: "legacy text\n" },
              { rel: "run.sh", content: "AAEC", encoding: "base64", mode: 0o755 },
            ],
          },
        ],
        metadata: {},
      },
    };
    writeFileSync(
      join(payloadDirectory(path), `${sha256(operationId)}.json`),
      JSON.stringify(inline),
    );

    const store = openDeployOperationStore(path);

    expect(store.read(operationId)?.staged.tasks[0]).toMatchObject({
      type: "skill",
      files: [
        { rel: "SKILL.md", content: "legacy text\n", encoding: "utf8", mode: 0o644 },
        { rel: "run.sh", content: "AAEC", encoding: "base64", mode: 0o755 },
      ],
    });
    expect(existsSync(blobDirectory(path))).toBe(false);
  });
});
