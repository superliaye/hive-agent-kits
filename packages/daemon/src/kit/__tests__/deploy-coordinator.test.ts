import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeployTarget, Source } from "@hive/contract";
import { Effect } from "effect";
import { withCooperativeFileLock } from "../../lib/durable-file.ts";
import { mirrorContentSha } from "../content-sha.ts";
import type { DeployFsExec } from "../deploy/adapter.ts";
import { hashSkillFiles } from "../deploy/artifact-hash.ts";
import { managedNpxBundleHash, managedNpxBundleMeta } from "../deploy/npx-bundle.ts";
import { bundleMeta } from "../deploy/sources.ts";
import {
  createDeployCoordinator,
  createDeploymentMutationCoordinator,
  DeployInProgressError,
  executeStagedDeploy,
  ImmutableInstallerStagingError,
  markInterruptedDeploymentState,
  PlanStaleError,
  resumeStagedDeploy,
  type StagedDeployPayload,
  stageDeployPlan,
} from "../deploy-coordinator.ts";
import {
  type DeployOperation,
  type DeployOperationOutcome,
  openDeployOperationStore,
  type StagedDeployTask,
  stagedSkillFile,
} from "../deploy-operations.ts";
import type { DeploymentSnapshot, DeployPlan } from "../deploy-plan.ts";
import { openDeploymentStateStore } from "../deployment-state.ts";
import { mergeLedger, readLedger } from "../ledger.ts";
import { readMirrorIdentity } from "../mirror.ts";
import { syncLocatorSource } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, fakeGitProcess, redirectHomeEnv } from "./helpers.ts";

const stagedText = (content: string) => ({
  rel: "SKILL.md",
  content,
  encoding: "utf8" as const,
  mode: 0o644 as const,
});

const roots: string[] = [];

afterEach(() => {
  clearHomeEnv();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function operationPath(): string {
  const root = mkdtempSync(join(tmpdir(), "deploy-coordinator-"));
  roots.push(root);
  return join(root, "operations.json");
}

function plan(
  overrides: Partial<DeployPlan> = {},
  action: DeployPlan["actions"][number] = {
    action: "add",
    key: { kind: "skill", name: "alpha" },
    target: "claude",
    sourceId: "source-a",
    contentSha: "a".repeat(64),
    renderedHash: "b".repeat(64),
    artifact: { existence: "missing", hash: null },
  },
): DeployPlan {
  return {
    selectionRevision: 7,
    sourceRegistryRevision: 3,
    mirrors: [{ sourceId: "source-a", precedence: 1, identity: "mirror-a" }],
    ledger: { revision: null, identity: "ledger-a" },
    deploymentStateRevision: 2,
    actions: [action],
    instructionWrites: [],
    blocked: [],
    ...overrides,
  };
}

function snapshot(deployPlan = plan()): DeploymentSnapshot {
  return {
    sources: [
      { id: "source-a", label: "Source A", kind: "git", active: true, rank: 1, recipe: null },
    ],
    sourceRegistryRevision: deployPlan.sourceRegistryRevision,
    mirrors: deployPlan.mirrors,
    catalog: { entries: [], presets: [], problems: [] },
    plugins: new Map(),
    selection: {
      revision: deployPlan.selectionRevision,
      enabled: [],
      removalIntents: [],
    },
    ledger: { revision: null, identity: deployPlan.ledger.identity, value: null },
    deploymentState: {
      schemaVersion: 1,
      revision: deployPlan.deploymentStateRevision,
      records: [],
    },
    wouldDeploy: [],
    artifacts: [],
    activeOperation: null,
    lastOperation: null,
  };
}

const staged = (value = "accepted"): StagedDeployPayload => ({
  tasks: [],
  metadata: { value },
});

type StagedSkillTask = Extract<StagedDeployTask, { type: "skill" }>;
type StagedManagedNpxTask = Extract<StagedDeployTask, { type: "npx-bundle" }>;

function managedNpxTask(
  verifyPath: string,
  overrides: Partial<StagedManagedNpxTask> = {},
): StagedManagedNpxTask {
  return {
    type: "npx-bundle",
    action: "add",
    key: { kind: "bundle", name: "archify" },
    target: "claude",
    package: `https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}`,
    skills: ["archify"],
    verifyPaths: [verifyPath],
    pin: `https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}`,
    sourceId: "source-a",
    contentSha: "b".repeat(64),
    renderedHash: "c".repeat(64),
    keep: [],
    ...overrides,
  };
}

function successOutcome(
  operation: DeployOperation,
  action = operation.plan.actions[0],
): DeployOperationOutcome {
  if (!action) throw new Error("fixture plan has no action");
  return {
    action: action.action,
    key: action.key,
    target: action.target,
    outcome: "succeeded",
    attemptedAt: 20,
  };
}

function coordinatorFixture(options: {
  deployPlan?: DeployPlan;
  planToken?: string;
  tokenForPlan?: Parameters<typeof createDeployCoordinator>[0]["tokenForPlan"];
  schedule?: (task: () => void) => void;
  execute?: Parameters<typeof createDeployCoordinator>[0]["execute"];
  resume?: Parameters<typeof createDeployCoordinator>[0]["resume"];
  stage?: Parameters<typeof createDeployCoordinator>[0]["stage"];
  onAccepted?: Parameters<typeof createDeployCoordinator>[0]["onAccepted"];
  clearRemovalIntents?: Parameters<typeof createDeployCoordinator>[0]["clearRemovalIntents"];
  capture?: Parameters<typeof createDeployCoordinator>[0]["capture"];
}) {
  const deployPlan = options.deployPlan ?? plan();
  const operations = openDeployOperationStore(operationPath(), { now: () => 10 });
  const coordinator = createDeployCoordinator({
    mutationCoordinator: createDeploymentMutationCoordinator(),
    operations,
    capture: options.capture ?? (() => ({ snapshot: snapshot(deployPlan), plan: deployPlan })),
    tokenForPlan: options.tokenForPlan ?? (() => options.planToken ?? "token-current"),
    stage: options.stage ?? (() => staged()),
    execute:
      options.execute ??
      (async (operation, record) => {
        await record([successOutcome(operation)]);
      }),
    ...(options.resume ? { resume: options.resume } : {}),
    onAccepted: options.onAccepted ?? (() => Promise.resolve()),
    clearRemovalIntents: options.clearRemovalIntents ?? (() => Promise.resolve()),
    operationId: () => "operation-1",
    now: () => 10,
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  return { coordinator, operations, deployPlan };
}

describe("persisted asynchronous Deploy coordinator", () => {
  test("rejects when the canonical snapshot changes while immutable bytes are staged", async () => {
    const first = plan();
    const changed = plan({ sourceRegistryRevision: first.sourceRegistryRevision + 1 });
    let captures = 0;
    const { coordinator, operations } = coordinatorFixture({
      capture: () => {
        const current = captures++ === 0 ? first : changed;
        return { snapshot: snapshot(current), plan: current };
      },
      stage: () => staged("expensive-staged-bytes"),
      tokenForPlan: (current) => `token-${current.sourceRegistryRevision}`,
    });

    await expect(
      coordinator.accept({ selectionRevision: 7, planToken: "token-3" }),
    ).rejects.toMatchObject({ code: "plan_stale" });
    expect(captures).toBe(2);
    expect(operations.list()).toEqual([]);
  });

  test("rejects a stale Selection revision or plan token before staging or persistence", async () => {
    let stageCalls = 0;
    const { coordinator, operations } = coordinatorFixture({
      stage: () => {
        stageCalls += 1;
        return staged();
      },
    });

    await expect(
      coordinator.accept({ selectionRevision: 6, planToken: "token-current" }),
    ).rejects.toBeInstanceOf(PlanStaleError);
    await expect(
      coordinator.accept({ selectionRevision: 7, planToken: "token-stale" }),
    ).rejects.toMatchObject({ code: "plan_stale" });
    expect(stageCalls).toBe(0);
    expect(operations.list()).toEqual([]);
  });

  test("persists the immutable queued operation before accept resolves and rejects another active Deploy", async () => {
    const scheduled: Array<() => void> = [];
    const { coordinator, operations } = coordinatorFixture({
      schedule: (task) => scheduled.push(task),
    });

    await expect(
      coordinator.accept({ selectionRevision: 7, planToken: "token-current" }),
    ).resolves.toEqual({ operationId: "operation-1" });
    const persisted = operations.read("operation-1");
    expect(persisted).toMatchObject({
      operationId: "operation-1",
      state: "queued",
      selectionRevision: 7,
      planToken: "token-current",
      staged: { metadata: { value: "accepted" } },
    });
    expect(JSON.parse(readFileSync(operations.path, "utf8"))).toMatchObject({
      operations: [{ operationId: "operation-1", state: "queued" }],
    });
    expect(scheduled).toHaveLength(1);

    await expect(
      coordinator.accept({ selectionRevision: 7, planToken: "token-current" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "deploy_in_progress",
        operationId: "operation-1",
      }),
    );
    await expect(
      coordinator.accept({ selectionRevision: 7, planToken: "token-current" }),
    ).rejects.toBeInstanceOf(DeployInProgressError);
  });

  test("round-trips the reason for a blocked instruction plan", () => {
    const operations = openDeployOperationStore(operationPath(), { now: () => 10 });
    const blockedPlan = plan({
      actions: [],
      blocked: [
        {
          kind: "instruction",
          target: "claude",
          reason: "unmanaged_owned",
          keys: [{ kind: "instruction", name: "rules" }],
        },
      ],
    });
    operations.createQueued({
      operationId: "blocked-plan",
      acceptedAt: 10,
      selectionRevision: blockedPlan.selectionRevision,
      planToken: "token",
      plan: blockedPlan,
      staged: { tasks: [], metadata: {} },
    });

    expect(operations.read("blocked-plan")?.plan.blocked).toEqual(blockedPlan.blocked);
  });

  test("background ownership survives request abandonment and executes the persisted staged payload", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen = "";
    const { coordinator, operations } = coordinatorFixture({
      execute: async (operation, record) => {
        await gate;
        seen = operation.staged.metadata.value ?? "";
        await record([successOutcome(operation)]);
      },
    });

    const accepted = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    expect(operations.activeSummary()).toMatchObject({ operationId: accepted.operationId });
    release?.();
    await coordinator.wait(accepted.operationId);

    expect(seen).toBe("accepted");
    expect(operations.read(accepted.operationId)?.state).toBe("completed");
  });

  test("Source and Selection changes after 202 cannot alter the staged operation", async () => {
    let mutableSourceBytes = "before";
    let mutableSelection = "before-selection";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executed = "";
    const { coordinator } = coordinatorFixture({
      stage: () => staged(`${mutableSourceBytes}:${mutableSelection}`),
      execute: async (operation, record) => {
        await gate;
        executed = operation.staged.metadata.value ?? "";
        await record([successOutcome(operation)]);
      },
    });

    const accepted = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    mutableSourceBytes = "after";
    mutableSelection = "after-selection";
    release?.();
    await coordinator.wait(accepted.operationId);

    expect(executed).toBe("before:before-selection");
  });

  test("executes immutable staged skill bytes after the accepted Mirror changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-staged-bytes-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const sourcePath = join(mirror, "capabilities", "skills", "alpha", "SKILL.md");
    const acceptedContent = "---\ndescription: accepted\n---\naccepted bytes\n";
    mkdirSync(join(sourcePath, ".."), { recursive: true });
    writeFileSync(sourcePath, acceptedContent);
    const contentSha = mirrorContentSha(mirror, "skill", "alpha");
    if (!contentSha) throw new Error("missing fixture ContentSha");
    const renderedHash = hashSkillFiles([stagedText(acceptedContent)].map(stagedSkillFile));
    const action: DeployPlan["actions"][number] = {
      action: "add",
      key: { kind: "skill", name: "alpha" },
      target: "claude",
      sourceId: "source-a",
      contentSha,
      renderedHash,
      artifact: { existence: "missing", hash: null },
    };
    const deployPlan = plan(
      {
        mirrors: [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }],
        actions: [action],
      },
      action,
    );
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const scheduled: Array<() => void> = [];
    const { coordinator, operations } = coordinatorFixture({
      deployPlan,
      schedule: (task) => scheduled.push(task),
      stage: (acceptedSnapshot, acceptedPlan) =>
        stageDeployPlan(targets, acceptedSnapshot, acceptedPlan),
      execute: (operation, record) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 20,
          },
          operation,
          record,
        ),
    });

    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    writeFileSync(sourcePath, "---\ndescription: changed\n---\nchanged bytes\n");
    scheduled[0]?.();
    await coordinator.wait(operationId);

    expect(readFileSync(join(homes.claudeHome, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
      acceptedContent,
    );
    expect(operations.read(operationId)).toMatchObject({
      state: "completed",
      outcomes: [{ target: "claude", outcome: "succeeded" }],
    });
    expect(deploymentState.read(action.key, "claude")?.applied).toMatchObject({
      sourceId: "source-a",
      contentSha,
      renderedHash,
    });
    expect(readLedger(targets)?.skills).toEqual([{ name: "alpha" }]);
  });

  test("does not touch deployment artifacts when the shared Ledger transaction cannot start", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-failure-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const baseTargets = failSafeDeployTargets();
    const blockedLedgerParent = join(root, "ledger-parent-is-a-file");
    writeFileSync(blockedLedgerParent, "not a directory");
    const targets = {
      ...baseTargets,
      ledgerPath: () => join(blockedLedgerParent, "manifest.json"),
    };
    const deploymentState = openDeploymentStateStore(baseTargets.deploymentStatePath(), {
      now: () => 20,
    });
    const operations = openDeployOperationStore(operationPath(), { now: () => 20 });
    const files = [stagedText("---\ndescription: staged\n---\nstaged\n")];
    const action = plan().actions[0];
    if (!action) throw new Error("missing action fixture");
    const payload: StagedDeployPayload = {
      tasks: [
        {
          type: "skill",
          action: "add",
          key: { kind: "skill", name: "alpha" },
          target: "claude",
          sourceId: "source-a",
          contentSha: "a".repeat(64),
          renderedHash: hashSkillFiles(files.map(stagedSkillFile)),
          files,
        },
      ],
      metadata: {},
    };
    operations.createQueued({
      operationId: "ledger-failure",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token",
      plan: plan(),
      staged: payload,
    });
    const operation = operations.markRunning("ledger-failure");

    await expect(
      executeStagedDeploy(
        {
          fx: {
            targets,
            exec: () => ({ status: 0, stdout: "", stderr: "" }),
            probe: () => false,
          },
          deploymentState,
          now: () => 20,
        },
        operation,
        async (outcomes) => {
          operations.recordOutcomes(operation.operationId, outcomes);
        },
      ),
    ).rejects.toThrow();

    expect(existsSync(join(homes.claudeHome, "skills", "alpha", "SKILL.md"))).toBe(false);
    expect(deploymentState.read(action.key, action.target)?.applied).toBeUndefined();
    expect(operations.read(operation.operationId)?.outcomes).toEqual([]);
  });

  test("backs up a whole instruction file before removing the last contribution", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-instruction-removal-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const instructionPath = join(homes.claudeHome, "CLAUDE.md");
    mkdirSync(dirname(instructionPath), { recursive: true });
    writeFileSync(instructionPath, "current instruction file\n");
    const action = {
      action: "remove",
      key: { kind: "instruction", name: "rules" },
      target: "claude",
      artifact: { existence: "present", hash: "a".repeat(64) },
    } satisfies DeployPlan["actions"][number];
    const acceptedPlan = plan({ actions: [action], mirrors: [] }, action);
    const operations = openDeployOperationStore(operationPath(), { now: () => 20 });
    operations.createQueued({
      operationId: "instruction-removal",
      acceptedAt: 10,
      selectionRevision: acceptedPlan.selectionRevision,
      planToken: "token",
      plan: acceptedPlan,
      staged: {
        tasks: [
          {
            type: "instruction",
            target: "claude",
            actions: [{ action: "remove", key: action.key, target: "claude" }],
            contributions: [],
            renderedHash: null,
            content: null,
          },
        ],
        metadata: {},
      },
    });
    const operation = operations.markRunning("instruction-removal");
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });

    await executeStagedDeploy(
      {
        fx: {
          targets,
          exec: () => ({ status: 0, stdout: "", stderr: "" }),
          probe: () => false,
        },
        deploymentState,
        now: () => 20,
      },
      operation,
      async (outcomes) => {
        operations.recordOutcomes(operation.operationId, outcomes);
      },
    );

    expect(existsSync(instructionPath)).toBe(false);
    expect(readFileSync(`${instructionPath}.hive-bak`, "utf8")).toBe("current instruction file\n");
  });

  test("recovers filesystem-only success when the Ledger-pending checkpoint write fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-checkpoint-failure-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const files = [stagedText("---\ndescription: alpha\n---\nalpha\n")];
    const renderedHash = hashSkillFiles(files.map(stagedSkillFile));
    const action = {
      action: "add",
      key: { kind: "skill", name: "alpha" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash,
      artifact: { existence: "missing", hash: null },
    } satisfies DeployPlan["actions"][number];
    const acceptedPlan = plan({ actions: [action], mirrors: [] }, action);
    const durableOperations = openDeployOperationStore(operationPath(), { now: () => 20 });
    const operations = {
      ...durableOperations,
      markLedgerPending: () => {
        throw new Error("checkpoint persistence unavailable");
      },
    };
    const coordinator = createDeployCoordinator({
      mutationCoordinator: createDeploymentMutationCoordinator(),
      operations,
      capture: () => ({ snapshot: snapshot(acceptedPlan), plan: acceptedPlan }),
      tokenForPlan: () => "token-current",
      stage: () => ({
        tasks: [
          {
            type: "skill",
            action: "add",
            key: action.key,
            target: action.target,
            sourceId: "source-a",
            contentSha: "a".repeat(64),
            renderedHash,
            files,
          },
        ],
        metadata: {},
      }),
      execute: (operation, journal) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 20,
          },
          operation,
          journal,
        ),
      onAccepted: () => Promise.resolve(),
      clearRemovalIntents: () => Promise.resolve(),
      operationId: () => "checkpoint-failure",
      now: () => 20,
    });

    const accepted = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await coordinator.wait(accepted.operationId);
    expect(readFileSync(join(homes.claudeHome, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
      files[0]?.content ?? "",
    );
    expect(readLedger(targets)).toBeNull();
    expect(deploymentState.read(action.key, action.target)?.applied).toBeUndefined();
    expect(durableOperations.read(accepted.operationId)).toMatchObject({
      state: "failed",
      executionPhase: "ledger_pending",
      provisionalOutcomes: [{ outcome: "succeeded", target: "claude" }],
    });

    const reopened = openDeployOperationStore(durableOperations.path, { now: () => 30 });
    const nextPlan = plan({ selectionRevision: 8, actions: [], mirrors: [] });
    const restarted = createDeployCoordinator({
      mutationCoordinator: createDeploymentMutationCoordinator(),
      operations: reopened,
      capture: () => ({ snapshot: snapshot(nextPlan), plan: nextPlan }),
      tokenForPlan: () => "token-next",
      stage: () => ({ tasks: [], metadata: {} }),
      execute: (operation, journal) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 30,
          },
          operation,
          journal,
        ),
      resume: (operation, journal) =>
        resumeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 30,
          },
          operation,
          journal,
        ),
      onAccepted: () => Promise.resolve(),
      clearRemovalIntents: () => Promise.resolve(),
      operationId: () => "operation-after-recovery",
      now: () => 30,
    });

    const next = await restarted.accept({ selectionRevision: 8, planToken: "token-next" });
    await restarted.wait(next.operationId);
    expect(reopened.read(accepted.operationId)).toMatchObject({
      state: "completed",
      executionPhase: "finished",
      outcomes: [{ outcome: "succeeded", target: "claude" }],
    });
    expect(readLedger(targets)?.skills).toEqual([{ name: "alpha" }]);
    expect(deploymentState.read(action.key, action.target)?.applied).toMatchObject({
      operationId: accepted.operationId,
      renderedHash,
    });
  });

  test("does not commit a stale removal after another writer restores the artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-removal-recovery-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 30,
    });
    const artifact = join(homes.claudeHome, "skills", "shared", "SKILL.md");
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "before\n");
    mergeLedger(
      targets,
      {
        kitVersion: "",
        targets: ["claude"],
        skills: ["shared"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const action = {
      action: "remove",
      key: { kind: "skill", name: "shared" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash: "b".repeat(64),
      artifact: { existence: "present", hash: "b".repeat(64) },
    } satisfies DeployPlan["actions"][number];
    const operations = openDeployOperationStore(operationPath(), { now: () => 20 });
    operations.createQueued({
      operationId: "stale-removal",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token",
      plan: plan({ actions: [action], mirrors: [] }, action),
      staged: {
        tasks: [{ type: "remove", action: "remove", key: action.key, target: "claude" }],
        metadata: {},
      },
    });
    const running = operations.markRunning("stale-removal");
    rmSync(dirname(artifact), { recursive: true, force: true });
    operations.recordProvisionalOutcomes("stale-removal", [successOutcome(running, action)]);
    operations.markLedgerPending("stale-removal");

    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "restored by agent-kit\n");
    const pending = operations.read("stale-removal");
    if (!pending) throw new Error("missing Ledger-pending operation");
    const journal = Object.assign(
      async (outcomes: readonly DeployOperationOutcome[]): Promise<void> => {
        operations.recordOutcomes(pending.operationId, outcomes);
      },
      {
        provisional: async (): Promise<void> => {},
        markLedgerPending: (): void => {},
        markLedgerCommitted: (): void => {
          operations.markLedgerCommitted(pending.operationId);
        },
        markFinalizing: (): void => {
          operations.markFinalizing(pending.operationId);
        },
      },
    );

    await resumeStagedDeploy(
      {
        fx: {
          targets,
          exec: () => ({ status: 0, stdout: "", stderr: "" }),
          probe: () => false,
        },
        deploymentState,
        now: () => 30,
      },
      pending,
      journal,
    );

    expect(readFileSync(artifact, "utf8")).toBe("restored by agent-kit\n");
    expect(readLedger(targets)?.skills).toContainEqual({ name: "shared" });
    expect(operations.read(pending.operationId)?.outcomes).toEqual([
      expect.objectContaining({ outcome: "failed", code: "recovery_state_changed" }),
    ]);
    expect(deploymentState.read(action.key, action.target)?.lastAttempt).toMatchObject({
      action: "remove",
      outcome: "failed",
      code: "recovery_state_changed",
    });
  });

  test("restart retries one shared Ledger-pending recovery after a real lock timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-lock-recovery-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const files = [stagedText("---\ndescription: alpha\n---\nalpha\n")];
    const renderedHash = hashSkillFiles(files.map(stagedSkillFile));
    const action = {
      action: "add",
      key: { kind: "skill", name: "alpha" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash,
      artifact: { existence: "missing", hash: null },
    } satisfies DeployPlan["actions"][number];
    const acceptedPlan = plan({ actions: [action], mirrors: [] }, action);
    const operations = openDeployOperationStore(operationPath(), { now: () => 20 });
    operations.createQueued({
      operationId: "ledger-lock-timeout",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: acceptedPlan,
      staged: {
        tasks: [
          {
            type: "skill",
            action: "add",
            key: action.key,
            target: action.target,
            sourceId: "source-a",
            contentSha: "a".repeat(64),
            renderedHash,
            files,
          },
        ],
        metadata: {},
      },
    });
    const runningOperation = operations.markRunning("ledger-lock-timeout");
    const provisional = successOutcome(runningOperation, action);
    operations.recordProvisionalOutcomes("ledger-lock-timeout", [provisional]);
    operations.markLedgerPending("ledger-lock-timeout");
    const artifact = join(homes.claudeHome, "skills", "alpha", "SKILL.md");
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, files[0]?.content ?? "");
    const pending = operations.read("ledger-lock-timeout");
    if (!pending) throw new Error("missing Ledger-pending operation");
    const journal = Object.assign(
      async (outcomes: readonly DeployOperationOutcome[]): Promise<void> => {
        operations.recordOutcomes(pending.operationId, outcomes);
      },
      {
        provisional: async (outcomes: readonly DeployOperationOutcome[]): Promise<void> => {
          operations.recordProvisionalOutcomes(pending.operationId, outcomes);
        },
        markLedgerPending: (): void => {
          operations.markLedgerPending(pending.operationId);
        },
        markLedgerCommitted: (): void => {
          operations.markLedgerCommitted(pending.operationId);
        },
        markFinalizing: (): void => {
          operations.markFinalizing(pending.operationId);
        },
      },
    );

    let lockedAttempt: Promise<void> | undefined;
    withCooperativeFileLock(targets.ledgerPath(), 500, () => {
      lockedAttempt = resumeStagedDeploy(
        {
          fx: {
            targets,
            exec: () => ({ status: 0, stdout: "", stderr: "" }),
            probe: () => false,
          },
          deploymentState,
          now: () => 20,
          ledgerWriteOptions: { lockTimeoutMs: 0 },
        },
        pending,
        journal,
      );
    });
    if (!lockedAttempt) throw new Error("Ledger recovery was not attempted");
    await expect(lockedAttempt).rejects.toMatchObject({ code: "ELOCKED" });
    expect(operations.read(pending.operationId)).toMatchObject({
      state: "running",
      executionPhase: "ledger_pending",
      outcomes: [],
    });
    expect(readLedger(targets)).toBeNull();
    expect(deploymentState.read(action.key, action.target)?.applied).toBeUndefined();

    const reopened = openDeployOperationStore(operations.path, { now: () => 30 });
    const scheduled: Array<() => void> = [];
    let resumeCalls = 0;
    let releaseResume: (() => void) | undefined;
    let markResumeStarted: (() => void) | undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });
    const nextPlan = plan({ selectionRevision: 8, actions: [], mirrors: [] });
    const restarted = createDeployCoordinator({
      mutationCoordinator: createDeploymentMutationCoordinator(),
      operations: reopened,
      capture: () => ({ snapshot: snapshot(nextPlan), plan: nextPlan }),
      tokenForPlan: () => "token-next",
      stage: () => staged("next"),
      execute: async () => {},
      resume: async (operation, record) => {
        resumeCalls += 1;
        markResumeStarted?.();
        await resumeGate;
        await resumeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 30,
          },
          operation,
          record,
        );
      },
      onAccepted: () => Promise.resolve(),
      clearRemovalIntents: () => Promise.resolve(),
      schedule: (task) => scheduled.push(task),
    });

    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await resumeStarted;
    const accepting = restarted.accept({ selectionRevision: 7, planToken: "token-current" });
    await Promise.resolve();
    expect(resumeCalls).toBe(1);
    releaseResume?.();
    await expect(accepting).rejects.toMatchObject({ code: "plan_stale" });

    expect(resumeCalls).toBe(1);
    expect(reopened.read(pending.operationId)).toMatchObject({
      state: "completed",
      executionPhase: "finished",
      outcomes: [{ outcome: "succeeded", target: "claude" }],
    });
    expect(readLedger(targets)?.skills).toEqual([{ name: "alpha" }]);
    expect(deploymentState.read(action.key, action.target)?.applied).toMatchObject({
      operationId: pending.operationId,
      renderedHash,
    });
  });

  test("rejects a relative setup command when no immutable checkout and cwd can be staged", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-setup-stage-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const descriptor = join(mirror, "capabilities", "bundles", "setup.bundle.md");
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(
      descriptor,
      `---
description: setup
source: https://example.invalid/setup.git
pinned_commit: ${"a".repeat(40)}
installer:
  kind: setup-script
  command: ./setup
---
setup
`,
    );
    const contentSha = mirrorContentSha(mirror, "bundle", "setup");
    if (!contentSha) throw new Error("missing setup ContentSha");
    const action: DeployPlan["actions"][number] = {
      action: "add",
      key: { kind: "bundle", name: "setup" },
      target: "claude",
      sourceId: "source-a",
      contentSha,
      renderedHash: contentSha,
      artifact: { existence: "missing", hash: null },
    };
    const deployPlan = plan({
      mirrors: [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }],
      actions: [action],
    });

    expect(() => stageDeployPlan(targets, snapshot(deployPlan), deployPlan)).toThrow(
      expect.objectContaining({ code: "immutable_installer_unavailable" }),
    );
    expect(() => stageDeployPlan(targets, snapshot(deployPlan), deployPlan)).toThrow(
      ImmutableInstallerStagingError,
    );
  });

  test("stages a hand-written plugin pointer like a generated one", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-plugin-stage-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const descriptor = join(mirror, "capabilities", "plugins", "plug.plugin.md");
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(
      descriptor,
      `---
description: plugin
marketplace_source: owner/market
marketplace_name: market
plugin_name: plug
pinned_commit: ${"b".repeat(40)}
---
plugin
`,
    );
    const contentSha = mirrorContentSha(mirror, "plugin", "plug");
    if (!contentSha) throw new Error("missing plugin ContentSha");
    const action: DeployPlan["actions"][number] = {
      action: "add",
      key: { kind: "plugin", name: "plug" },
      target: "claude",
      sourceId: "source-a",
      contentSha,
      renderedHash: contentSha,
      artifact: { existence: "missing", hash: null },
    };
    const deployPlan = plan({
      mirrors: [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }],
      actions: [action],
    });

    expect(stageDeployPlan(targets, snapshot(deployPlan), deployPlan).tasks).toEqual([
      {
        type: "marketplace-plugin",
        action: "add",
        key: { kind: "plugin", name: "plug" },
        target: "claude",
        marketplaceSource: "owner/market",
        marketplaceName: "market",
        pluginName: "plug",
        sourceId: "source-a",
        contentSha,
      },
    ]);
  });

  test("stages a managed marketplace plugin as one task per declared target", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-marketplace-stage-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const repoUrl = "https://github.com/superliaye/yestack";
    const source: Source = {
      id: "source-a",
      label: "yestack",
      locator: {
        kind: "git",
        repoUrl,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: repoUrl,
      kind: "git",
      active: true,
      createdAt: 0,
      rank: 1,
    };
    const marketplace = JSON.stringify({
      name: "yestack",
      plugins: [{ name: "ye", source: "./plugins/ye" }],
    });
    const { process: gitProcess } = fakeGitProcess([
      { path: ".claude-plugin/marketplace.json", content: marketplace },
    ]);
    await Effect.runPromise(syncLocatorSource(source, targets, { gitProcess }));
    const contentSha = mirrorContentSha(mirror, "plugin", "ye");
    if (!contentSha) throw new Error("missing plugin ContentSha");
    const action = (target: DeployTarget): DeployPlan["actions"][number] => ({
      action: "add",
      key: { kind: "plugin", name: "ye" },
      target,
      sourceId: "source-a",
      contentSha,
      renderedHash: null,
      artifact: { existence: "missing", hash: null },
    });
    const mirrors = [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }];

    const claudePlan = plan({ mirrors, actions: [action("claude")] });
    expect(stageDeployPlan(targets, snapshot(claudePlan), claudePlan).tasks).toEqual([
      {
        type: "marketplace-plugin",
        action: "add",
        key: { kind: "plugin", name: "ye" },
        target: "claude",
        marketplaceSource: "https://github.com/superliaye/yestack",
        marketplaceName: "yestack",
        pluginName: "ye",
        sourceId: "source-a",
        contentSha,
      },
    ]);
    // The Claude marketplace file alone lists the plugin, so Codex is not a target.
    const codexPlan = plan({ mirrors, actions: [action("codex")] });
    expect(() => stageDeployPlan(targets, snapshot(codexPlan), codexPlan)).toThrow(PlanStaleError);
  });

  test("runs each CLI's refresh sequence and records the installed plugin", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-marketplace-exec-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const task = (target: DeployTarget): StagedDeployTask => ({
      type: "marketplace-plugin",
      action: "add",
      key: { kind: "plugin", name: "ye" },
      target,
      marketplaceSource: "https://github.com/superliaye/yestack",
      marketplaceName: "yestack",
      pluginName: "ye",
      sourceId: "source-a",
      contentSha: "d".repeat(64),
    });
    const action = (target: DeployTarget): DeployPlan["actions"][number] => ({
      action: "add",
      key: { kind: "plugin", name: "ye" },
      target,
      sourceId: "source-a",
      contentSha: "d".repeat(64),
      renderedHash: null,
      artifact: { existence: "missing", hash: null },
    });
    const deployPlan = plan({ mirrors: [], actions: [action("claude"), action("codex")] });
    const store = openDeployOperationStore(operationPath());
    store.createQueued({
      operationId: "marketplace-add",
      acceptedAt: 1,
      selectionRevision: deployPlan.selectionRevision,
      planToken: "token",
      plan: deployPlan,
      staged: { tasks: [task("claude"), task("codex")], metadata: {} },
    });
    const argv: string[] = [];
    let outcomes: DeployOperationOutcome[] = [];

    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: (name) => name === "claude" || name === "codex",
          exec: (request) => {
            argv.push([request.command, ...request.args].join(" "));
            if (request.command === "claude" && request.args[1] === "install") {
              mkdirSync(join(homes.claudeHome, "plugins"), { recursive: true });
              writeFileSync(
                join(homes.claudeHome, "plugins", "installed_plugins.json"),
                JSON.stringify({ version: 2, plugins: { "ye@yestack": [{ scope: "user" }] } }),
              );
            }
            if (request.command === "codex" && request.args[1] === "add") {
              mkdirSync(homes.codexHome, { recursive: true });
              writeFileSync(
                join(homes.codexHome, "config.toml"),
                '[plugins."ye@yestack"]\nenabled = true\n',
              );
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        deploymentState,
        now: () => 20,
      },
      store.markRunning("marketplace-add"),
      async (recorded) => {
        outcomes = [...recorded];
      },
    );

    expect(argv).toEqual([
      "claude plugin marketplace add https://github.com/superliaye/yestack",
      "claude plugin marketplace update yestack",
      "claude plugin install ye@yestack --scope user",
      "claude plugin update ye@yestack",
      "codex plugin marketplace add https://github.com/superliaye/yestack",
      "codex plugin marketplace upgrade yestack",
      "codex plugin add ye@yestack",
    ]);
    expect(outcomes.map((outcome) => [outcome.target, outcome.outcome])).toEqual([
      ["claude", "succeeded"],
      ["codex", "succeeded"],
    ]);
    expect(readLedger(targets)?.plugins.map((entry) => entry.name)).toEqual(["ye"]);
    for (const target of ["claude", "codex"] as const) {
      expect(deploymentState.read({ kind: "plugin", name: "ye" }, target)?.applied).toMatchObject({
        sourceId: "source-a",
        contentSha: "d".repeat(64),
        installedVia: {
          installer: "marketplace-plugin",
          marketplaceName: "yestack",
          pluginName: "ye",
        },
      });
    }
  });

  test("fails a marketplace plugin on a missing CLI, a nonzero exit, or no install record", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-marketplace-failures-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const run = async (
      id: string,
      fx: Pick<DeployFsExec, "exec" | "probe">,
    ): Promise<DeployOperationOutcome> => {
      const action: DeployPlan["actions"][number] = {
        action: "add",
        key: { kind: "plugin", name: "ye" },
        target: "codex",
        sourceId: "source-a",
        contentSha: "d".repeat(64),
        renderedHash: null,
        artifact: { existence: "missing", hash: null },
      };
      const deployPlan = plan({ actions: [action], mirrors: [] }, action);
      const store = openDeployOperationStore(operationPath());
      store.createQueued({
        operationId: id,
        acceptedAt: 1,
        selectionRevision: deployPlan.selectionRevision,
        planToken: id,
        plan: deployPlan,
        staged: {
          tasks: [
            {
              type: "marketplace-plugin",
              action: "add",
              key: { kind: "plugin", name: "ye" },
              target: "codex",
              marketplaceSource: "https://github.com/superliaye/yestack",
              marketplaceName: "yestack",
              pluginName: "ye",
              sourceId: "source-a",
              contentSha: "d".repeat(64),
            },
          ],
          metadata: {},
        },
      });
      let observed: DeployOperationOutcome[] = [];
      await executeStagedDeploy(
        { fx: { targets, ...fx }, deploymentState, now: () => 20 },
        store.markRunning(id),
        async (outcomes) => {
          observed = [...outcomes];
        },
      );
      const outcome = observed[0];
      if (!outcome) throw new Error("missing outcome");
      return outcome;
    };

    let execCalls = 0;
    const missing = await run("missing-codex", {
      probe: () => false,
      exec: () => {
        execCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(missing).toMatchObject({ outcome: "failed", code: "missing_binary" });
    expect(execCalls).toBe(0);

    const nonzero = await run("nonzero-codex", {
      probe: () => true,
      exec: () => ({ status: 1, stdout: "", stderr: "Error: marketplace not found" }),
    });
    expect(nonzero).toMatchObject({ outcome: "failed", code: "installer_failed" });
    expect(nonzero.detail).toContain("marketplace not found");

    const unrecorded = await run("unrecorded-codex", {
      probe: () => true,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(unrecorded).toMatchObject({ outcome: "failed", code: "installer_failed" });
    expect(unrecorded.detail).toContain("without recording ye@yestack");
  });

  test("stages a plugin removal from its install record, or from its pointer for an older record", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-plugin-remove-stage-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const descriptor = join(mirror, "capabilities", "plugins", "plug.plugin.md");
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(
      descriptor,
      "---\ndescription: plugin\nmarketplace_source: owner/market\nmarketplace_name: market\nplugin_name: plug\n---\n",
    );
    const contentSha = mirrorContentSha(mirror, "plugin", "plug");
    if (!contentSha) throw new Error("missing plugin ContentSha");
    const key = { kind: "plugin" as const, name: "plug" };
    const record = (installedVia?: {
      installer: "marketplace-plugin";
      marketplaceName: string;
      pluginName: string;
    }) => ({
      key,
      target: "claude" as const,
      applied: {
        sourceId: "source-a",
        contentSha,
        renderedHash: contentSha,
        appliedAt: 1,
        operationId: "op-1",
        ...(installedVia ? { installedVia } : {}),
      },
      lastAttempt: {
        action: "add" as const,
        outcome: "succeeded" as const,
        attemptedAt: 1,
        operationId: "op-1",
      },
    });
    const stage = (action: DeployPlan["actions"][number], records: ReturnType<typeof record>[]) => {
      const deployPlan = plan({
        mirrors: [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }],
        actions: [action],
      });
      const captured = snapshot(deployPlan);
      return stageDeployPlan(
        targets,
        { ...captured, deploymentState: { ...captured.deploymentState, records } },
        deployPlan,
      ).tasks;
    };
    const removal = {
      type: "marketplace-plugin-remove",
      action: "remove",
      key,
      target: "claude",
    } as const;

    // The record wins over a pointer that now names another marketplace.
    expect(
      stage(
        {
          action: "remove",
          key,
          target: "claude",
          artifact: { existence: "missing", hash: null },
        },
        [
          record({
            installer: "marketplace-plugin",
            marketplaceName: "old-market",
            pluginName: "plug",
          }),
        ],
      ),
    ).toEqual([{ ...removal, marketplaceName: "old-market", pluginName: "plug" }]);
    expect(
      stage(
        {
          action: "remove",
          key,
          target: "claude",
          sourceId: "source-a",
          contentSha,
          artifact: { existence: "missing", hash: null },
        },
        [record()],
      ),
    ).toEqual([{ ...removal, marketplaceName: "market", pluginName: "plug" }]);
  });

  test("uninstalls a plugin through each CLI, records the removal, and prunes the Ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-marketplace-remove-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const key = { kind: "plugin" as const, name: "ye" };
    for (const target of ["claude", "codex"] as const) {
      deploymentState.recordSuccess(
        key,
        target,
        {
          sourceId: "source-a",
          contentSha: "d".repeat(64),
          renderedHash: "d".repeat(64),
          appliedAt: 10,
          installedVia: {
            installer: "marketplace-plugin",
            marketplaceName: "yestack",
            pluginName: "ye",
          },
        },
        "op-install",
      );
    }
    mergeLedger(
      targets,
      {
        kitVersion: "",
        targets: ["claude", "codex"],
        skills: [],
        agents: [],
        instructions: [],
        plugins: ["ye"],
        bundles: [],
      },
      [],
      [],
    );
    const installedPlugins = join(homes.claudeHome, "plugins", "installed_plugins.json");
    const codexConfig = join(homes.codexHome, "config.toml");
    mkdirSync(dirname(installedPlugins), { recursive: true });
    writeFileSync(installedPlugins, JSON.stringify({ plugins: { "ye@yestack": [{}] } }));
    mkdirSync(homes.codexHome, { recursive: true });
    writeFileSync(codexConfig, '[plugins."ye@yestack"]\nenabled = true\n');

    const action = (target: DeployTarget): DeployPlan["actions"][number] => ({
      action: "remove",
      key,
      target,
      artifact: { existence: "missing", hash: null },
    });
    const task = (target: DeployTarget): StagedDeployTask => ({
      type: "marketplace-plugin-remove",
      action: "remove",
      key,
      target,
      marketplaceName: "yestack",
      pluginName: "ye",
    });
    const deployPlan = plan({ mirrors: [], actions: [action("claude"), action("codex")] });
    const store = openDeployOperationStore(operationPath());
    store.createQueued({
      operationId: "marketplace-remove",
      acceptedAt: 1,
      selectionRevision: deployPlan.selectionRevision,
      planToken: "token",
      plan: deployPlan,
      staged: { tasks: [task("claude"), task("codex")], metadata: {} },
    });
    const argv: string[] = [];
    let outcomes: DeployOperationOutcome[] = [];

    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: (name) => name === "claude" || name === "codex",
          exec: (request) => {
            argv.push([request.command, ...request.args].join(" "));
            if (request.command === "claude") writeFileSync(installedPlugins, '{"plugins":{}}');
            if (request.command === "codex") writeFileSync(codexConfig, "");
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        deploymentState,
        now: () => 20,
      },
      store.markRunning("marketplace-remove"),
      async (recorded) => {
        outcomes = [...recorded];
      },
    );

    expect(argv).toEqual([
      "claude plugin uninstall ye@yestack --scope user",
      "codex plugin remove ye@yestack",
    ]);
    expect(outcomes.map((outcome) => [outcome.target, outcome.outcome])).toEqual([
      ["claude", "succeeded"],
      ["codex", "succeeded"],
    ]);
    for (const target of ["claude", "codex"] as const) {
      expect(deploymentState.read(key, target)?.applied).toBeUndefined();
    }
    expect(readLedger(targets)?.plugins).toEqual([]);

    // A plugin the CLI no longer records is already uninstalled.
    argv.length = 0;
    const again = openDeployOperationStore(operationPath());
    again.createQueued({
      operationId: "marketplace-remove-again",
      acceptedAt: 2,
      selectionRevision: deployPlan.selectionRevision,
      planToken: "token-again",
      plan: deployPlan,
      staged: { tasks: [task("claude")], metadata: {} },
    });
    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: () => true,
          exec: (request) => {
            argv.push(request.command);
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        deploymentState,
        now: () => 30,
      },
      again.markRunning("marketplace-remove-again"),
      async () => {},
    );
    expect(argv).toEqual([]);
  });

  test("an npx bundle removal runs the full uninstall, then reinstalls each kept target", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-managed-npx-keep-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const packageCommit = "b".repeat(40);
    const packageRef = `https://github.com/tt-a1i/archify/tree/${packageCommit}`;
    const claudePath = join(homes.claudeHome, "skills", "archify");
    const codexPath = join(targets.agentsHome(), "skills", "archify");
    mkdirSync(claudePath, { recursive: true });
    mkdirSync(codexPath, { recursive: true });
    const task = managedNpxTask(codexPath, {
      action: "remove",
      target: "codex",
      package: packageRef,
      pin: packageRef,
      keep: [
        { target: "claude", package: packageRef, skills: ["archify"], verifyPaths: [claudePath] },
      ],
    });
    const action: DeployPlan["actions"][number] = {
      action: "remove",
      key: task.key,
      target: "codex",
      artifact: { existence: "missing", hash: null },
    };
    const deployPlan = plan({ actions: [action], mirrors: [] }, action);
    const store = openDeployOperationStore(operationPath());
    store.createQueued({
      operationId: "managed-npx-keep",
      acceptedAt: 1,
      selectionRevision: deployPlan.selectionRevision,
      planToken: "token",
      plan: deployPlan,
      staged: { tasks: [task], metadata: {} },
    });
    const npx: string[][] = [];
    let outcomes: DeployOperationOutcome[] = [];

    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: () => true,
          exec: (request) => {
            if (request.command === "npx") {
              npx.push(request.args);
              // The CLI's full uninstall clears every agent; the reinstall restores Claude.
              if (request.args[2] === "remove") {
                rmSync(claudePath, { recursive: true, force: true });
                rmSync(codexPath, { recursive: true, force: true });
              } else {
                mkdirSync(claudePath, { recursive: true });
              }
            }
            return {
              status: 0,
              stdout: request.args.includes("rev-parse") ? `${packageCommit}\n` : "",
              stderr: "",
            };
          },
        },
        deploymentState,
        now: () => 20,
      },
      store.markRunning("managed-npx-keep"),
      async (recorded) => {
        outcomes = [...recorded];
      },
    );

    expect(npx).toEqual([
      ["-y", "skills", "remove", "archify", "--global", "--yes"],
      [
        "-y",
        "skills",
        "add",
        ".",
        "--global",
        "--agent",
        "claude-code",
        "--copy",
        "--skill",
        "archify",
        "--yes",
      ],
    ]);
    expect(outcomes).toMatchObject([{ target: "codex", outcome: "succeeded" }]);
    expect(existsSync(claudePath)).toBe(true);
    expect(existsSync(codexPath)).toBe(false);
  });

  test("rejects a mutable npx package instead of resolving it after acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-npx-stage-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const descriptor = join(mirror, "capabilities", "bundles", "skills.bundle.md");
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(
      descriptor,
      `---
description: npx
installer:
  kind: npx-skills
  package: owner/repository
---
npx
`,
    );
    const contentSha = mirrorContentSha(mirror, "bundle", "skills");
    if (!contentSha) throw new Error("missing npx ContentSha");
    const action: DeployPlan["actions"][number] = {
      action: "add",
      key: { kind: "bundle", name: "skills" },
      target: "codex",
      sourceId: "source-a",
      contentSha,
      renderedHash: contentSha,
      artifact: { existence: "missing", hash: null },
    };
    const deployPlan = plan({
      mirrors: [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }],
      actions: [action],
    });

    expect(() => stageDeployPlan(targets, snapshot(deployPlan), deployPlan)).toThrow(
      expect.objectContaining({ code: "immutable_installer_unavailable" }),
    );
  });

  test("stages and persists complete immutable npx bundle tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-managed-npx-stage-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const descriptor = join(mirror, "capabilities", "bundles", "archify.bundle.md");
    const packageRef = `https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}`;
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(
      descriptor,
      `---\ndescription: Archify\ninstaller:\n  kind: npx-skills\n  package: ${packageRef}\n  skills: [archify]\nverify_paths:\n  claude: ~/.claude/skills/archify\n  codex: ~/.agents/skills/archify\n---\n`,
    );
    const contentSha = mirrorContentSha(mirror, "bundle", "archify");
    const parsed = bundleMeta(mirror, "archify");
    if (!contentSha || !parsed) throw new Error("missing managed bundle fixture");
    const claudeMeta = managedNpxBundleMeta(parsed, "claude", targets);
    const codexMeta = managedNpxBundleMeta(parsed, "codex", targets);
    if (!claudeMeta || !codexMeta) throw new Error("ineligible managed bundle fixture");
    const add: DeployPlan["actions"][number] = {
      action: "add",
      key: { kind: "bundle", name: "archify" },
      target: "claude",
      sourceId: "source-a",
      contentSha,
      renderedHash: managedNpxBundleHash(claudeMeta, "claude"),
      artifact: { existence: "missing", hash: null },
    };
    const remove: DeployPlan["actions"][number] = {
      action: "remove",
      key: { kind: "bundle", name: "archify" },
      target: "codex",
      sourceId: "source-a",
      contentSha,
      renderedHash: managedNpxBundleHash(codexMeta, "codex"),
      artifact: { existence: "present", hash: managedNpxBundleHash(codexMeta, "codex") },
    };
    const deployPlan = plan({
      mirrors: [{ sourceId: "source-a", precedence: 1, identity: readMirrorIdentity(mirror) }],
      actions: [add, remove],
    });

    const payload = stageDeployPlan(targets, snapshot(deployPlan), deployPlan);
    expect(payload.tasks).toEqual([
      {
        type: "npx-bundle",
        action: "add",
        key: { kind: "bundle", name: "archify" },
        target: "claude",
        package: packageRef,
        skills: ["archify"],
        verifyPaths: [join(targets.claudeHome(), "skills", "archify")],
        pin: packageRef,
        sourceId: "source-a",
        contentSha,
        renderedHash: managedNpxBundleHash(claudeMeta, "claude"),
        keep: [],
      },
      {
        type: "npx-bundle",
        action: "remove",
        key: { kind: "bundle", name: "archify" },
        target: "codex",
        package: packageRef,
        skills: ["archify"],
        verifyPaths: [join(targets.agentsHome(), "skills", "archify")],
        pin: packageRef,
        sourceId: "source-a",
        contentSha,
        renderedHash: managedNpxBundleHash(codexMeta, "codex"),
        // Claude is added in the same Deploy, so the full uninstall reinstalls it.
        keep: [
          {
            target: "claude",
            package: packageRef,
            skills: ["archify"],
            verifyPaths: [join(targets.claudeHome(), "skills", "archify")],
          },
        ],
      },
    ]);

    const store = openDeployOperationStore(operationPath());
    expect(
      store.createQueued({
        operationId: "managed-npx-persisted",
        acceptedAt: 1,
        selectionRevision: deployPlan.selectionRevision,
        planToken: "token",
        plan: deployPlan,
        staged: payload,
      }).staged.tasks,
    ).toEqual(payload.tasks);
  });

  test("executes exact npx add/remove argv and verifies filesystem postconditions", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-managed-npx-exec-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const packageCommit = "b".repeat(40);
    const packageRef = `https://github.com/tt-a1i/archify/tree/${packageCommit}`;
    const renderedHash = "c".repeat(64);
    const verifyPath = join(homes.claudeHome, "skills", "archify");
    const action: DeployPlan["actions"][number] = {
      action: "add",
      key: { kind: "bundle", name: "archify" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "d".repeat(64),
      renderedHash,
      artifact: { existence: "missing", hash: null },
    };
    const addPlan = plan({ actions: [action], mirrors: [] }, action);
    const addStore = openDeployOperationStore(operationPath());
    addStore.createQueued({
      operationId: "managed-npx-add",
      acceptedAt: 1,
      selectionRevision: addPlan.selectionRevision,
      planToken: "token",
      plan: addPlan,
      staged: {
        tasks: [
          {
            type: "npx-bundle",
            action: "add",
            key: action.key,
            target: "claude",
            package: packageRef,
            skills: ["archify"],
            verifyPaths: [verifyPath],
            pin: packageRef,
            sourceId: "source-a",
            contentSha: "d".repeat(64),
            renderedHash,
          },
        ],
        metadata: {},
      } as unknown as StagedDeployPayload,
    });
    const requests: Array<{
      command: string;
      args: string[];
      cwd: string | undefined;
      claudeHome: string | undefined;
    }> = [];
    let addOutcomes: DeployOperationOutcome[] = [];
    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: (name) => name === "npx" || name === "git",
          exec: (request, env) => {
            requests.push({
              command: request.command,
              args: request.args,
              cwd: request.cwd,
              claudeHome: env.CLAUDE_CONFIG_DIR,
            });
            if (request.command === "npx") mkdirSync(verifyPath, { recursive: true });
            return {
              status: 0,
              stdout: request.args.includes("rev-parse") ? `${packageCommit}\n` : "installed",
              stderr: "",
            };
          },
        },
        deploymentState,
        now: () => 20,
      },
      addStore.markRunning("managed-npx-add"),
      async (outcomes) => {
        addOutcomes = [...outcomes];
      },
    );
    const fetch = requests.find(
      (request) => request.command === "git" && request.args.includes("fetch"),
    );
    expect(fetch?.args).toContain(packageCommit);
    expect(fetch?.args).toContain("--depth");
    expect(requests.find((request) => request.command === "npx")).toEqual({
      command: "npx",
      args: [
        "-y",
        "skills",
        "add",
        ".",
        "--global",
        "--agent",
        "claude-code",
        "--copy",
        "--skill",
        "archify",
        "--yes",
      ],
      cwd: expect.stringContaining(packageCommit),
      claudeHome: homes.claudeHome,
    });
    expect(addOutcomes).toMatchObject([{ outcome: "succeeded" }]);
    expect(deploymentState.read(action.key, "claude")?.applied).toMatchObject({
      sourceId: "source-a",
      contentSha: "d".repeat(64),
      renderedHash,
      installedVia: {
        installer: "npx-skills",
        package: packageRef,
        skills: ["archify"],
        verifyPaths: [verifyPath],
      },
    });
    expect(readLedger(targets)?.bundles).toEqual([{ name: "archify", pin: packageRef }]);

    const removeAction: DeployPlan["actions"][number] = {
      ...action,
      action: "remove",
      sourceId: "source-a",
      contentSha: "d".repeat(64),
      artifact: { existence: "present", hash: renderedHash },
    };
    const removePlan = plan({ actions: [removeAction], mirrors: [] }, removeAction);
    const removeStore = openDeployOperationStore(operationPath());
    removeStore.createQueued({
      operationId: "managed-npx-remove",
      acceptedAt: 2,
      selectionRevision: removePlan.selectionRevision,
      planToken: "token-remove",
      plan: removePlan,
      staged: {
        tasks: [
          {
            type: "npx-bundle",
            action: "remove",
            key: removeAction.key,
            target: "claude",
            package: packageRef,
            skills: ["archify"],
            verifyPaths: [verifyPath],
            pin: packageRef,
            sourceId: "source-a",
            contentSha: "d".repeat(64),
            renderedHash,
          },
        ],
        metadata: {},
      } as unknown as StagedDeployPayload,
    });
    requests.length = 0;
    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: () => true,
          exec: (request) => {
            requests.push({
              command: request.command,
              args: request.args,
              cwd: request.cwd,
              claudeHome: undefined,
            });
            rmSync(verifyPath, { recursive: true, force: true });
            return { status: 0, stdout: "removed", stderr: "" };
          },
        },
        deploymentState,
        now: () => 30,
      },
      removeStore.markRunning("managed-npx-remove"),
      async () => {},
    );
    expect(requests[0]?.args).toEqual(["-y", "skills", "remove", "archify", "--global", "--yes"]);
    expect(deploymentState.read(removeAction.key, "claude")?.applied).toBeUndefined();
    expect(readLedger(targets)?.bundles).toEqual([]);
  });

  test("reports missing npx, nonzero exit, and unsatisfied postconditions with bounded details", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-managed-npx-failures-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const run = async (
      id: string,
      fx: Pick<DeployFsExec, "exec" | "probe">,
    ): Promise<DeployOperationOutcome> => {
      const task = managedNpxTask(join(targets.claudeHome(), "skills", id));
      const action: DeployPlan["actions"][number] = {
        action: task.action,
        key: task.key,
        target: task.target,
        sourceId: task.sourceId ?? undefined,
        contentSha: task.contentSha ?? undefined,
        renderedHash: task.renderedHash,
        artifact: { existence: "missing", hash: null },
      };
      const deployPlan = plan({ actions: [action], mirrors: [] }, action);
      const store = openDeployOperationStore(operationPath());
      store.createQueued({
        operationId: id,
        acceptedAt: 1,
        selectionRevision: deployPlan.selectionRevision,
        planToken: id,
        plan: deployPlan,
        staged: { tasks: [task], metadata: {} },
      });
      let observed: DeployOperationOutcome[] = [];
      await executeStagedDeploy(
        { fx: { targets, ...fx }, deploymentState, now: () => 20 },
        store.markRunning(id),
        async (outcomes) => {
          observed = [...outcomes];
        },
      );
      const outcome = observed[0];
      if (!outcome) throw new Error("missing failure outcome");
      return outcome;
    };

    let execCalls = 0;
    const missing = await run("missing-npx", {
      probe: () => false,
      exec: () => {
        execCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(missing).toMatchObject({ outcome: "failed", code: "missing_binary" });
    expect(execCalls).toBe(0);

    const nonzero = await run("nonzero-npx", {
      probe: () => true,
      exec: (request) => {
        if (request.command === "git") {
          return {
            status: 0,
            stdout: request.args.includes("rev-parse") ? `${"a".repeat(40)}\n` : "",
            stderr: "",
          };
        }
        return {
          status: 9,
          stdout: `\u001b[32m${"installer banner ".repeat(50)}\u001b[0m\ntoken=private fatal: Remote branch ${"a".repeat(40)} not found`,
          stderr: "",
        };
      },
    });
    expect(nonzero).toMatchObject({ outcome: "failed", code: "installer_failed" });
    expect(nonzero.detail).toContain("token=<redacted>");
    expect(nonzero.detail).toContain("fatal: Remote branch");
    expect(nonzero.detail).not.toContain("\u001b[");
    expect(nonzero.detail?.length).toBeLessThanOrEqual(512);
    expect(
      deploymentState.read({ kind: "bundle", name: "archify" }, "claude")?.lastAttempt,
    ).toMatchObject({
      outcome: "failed",
      code: "installer_failed",
      detail: expect.stringContaining("token=<redacted>"),
    });

    const missingEffect = await run("missing-effect", {
      probe: () => true,
      exec: (request) => ({
        status: 0,
        stdout:
          request.command === "git" && request.args.includes("rev-parse")
            ? `${"a".repeat(40)}\n`
            : "ok",
        stderr: "",
      }),
    });
    expect(missingEffect).toMatchObject({ outcome: "failed", code: "installer_failed" });
    expect(missingEffect.detail).toContain("postcondition");
  });

  test("continues unrelated staged file work after a managed bundle failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-managed-npx-mixed-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const npxTask = managedNpxTask(join(homes.claudeHome, "skills", "archify"));
    const files = [stagedText("---\ndescription: local\n---\nlocal\n")];
    const skillTask: StagedSkillTask = {
      type: "skill",
      action: "add",
      key: { kind: "skill", name: "local" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "d".repeat(64),
      renderedHash: hashSkillFiles(files.map(stagedSkillFile)),
      files,
    };
    const actions: DeployPlan["actions"] = [npxTask, skillTask].map((task) => ({
      action: task.action,
      key: task.key,
      target: task.target,
      sourceId: task.sourceId ?? undefined,
      contentSha: task.contentSha ?? undefined,
      renderedHash: task.renderedHash,
      artifact: { existence: "missing" as const, hash: null },
    }));
    const deployPlan = plan({ actions, mirrors: [] }, actions[0]);
    const store = openDeployOperationStore(operationPath());
    store.createQueued({
      operationId: "managed-npx-mixed",
      acceptedAt: 1,
      selectionRevision: deployPlan.selectionRevision,
      planToken: "mixed",
      plan: deployPlan,
      staged: { tasks: [npxTask, skillTask], metadata: {} },
    });
    let outcomes: DeployOperationOutcome[] = [];
    await executeStagedDeploy(
      {
        fx: {
          targets,
          probe: () => true,
          exec: () => ({ status: 1, stdout: "", stderr: "failed" }),
        },
        deploymentState,
        now: () => 20,
      },
      store.markRunning("managed-npx-mixed"),
      async (next) => {
        outcomes = [...next];
      },
    );
    expect(outcomes.map(({ key, outcome }) => [key.name, outcome])).toEqual([
      ["archify", "failed"],
      ["local", "succeeded"],
    ]);
    expect(readFileSync(join(homes.claudeHome, "skills", "local", "SKILL.md"), "utf8")).toContain(
      "local",
    );
  });

  test("recovery probes managed bundle effects before rerunning or committing", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-managed-npx-recovery-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 30,
    });
    const verifyPath = join(homes.claudeHome, "skills", "archify");
    const task = managedNpxTask(verifyPath);
    const action: DeployPlan["actions"][number] = {
      action: "add",
      key: task.key,
      target: task.target,
      sourceId: task.sourceId ?? undefined,
      contentSha: task.contentSha ?? undefined,
      renderedHash: task.renderedHash,
      artifact: { existence: "missing", hash: null },
    };
    const deployPlan = plan({ actions: [action], mirrors: [] }, action);
    const store = openDeployOperationStore(operationPath());
    store.createQueued({
      operationId: "managed-npx-recovery",
      acceptedAt: 1,
      selectionRevision: deployPlan.selectionRevision,
      planToken: "recovery",
      plan: deployPlan,
      staged: { tasks: [task], metadata: {} },
    });
    const applying = store.markRunning("managed-npx-recovery");
    mkdirSync(verifyPath, { recursive: true });
    let execCalls = 0;
    let final: DeployOperationOutcome[] = [];
    const journal = Object.assign(
      async (outcomes: readonly DeployOperationOutcome[]) => {
        final = [...outcomes];
      },
      {
        provisional: async () => {},
        markLedgerPending: () => {},
        markLedgerCommitted: () => {},
        markFinalizing: () => {},
      },
    );
    await resumeStagedDeploy(
      {
        fx: {
          targets,
          probe: () => true,
          exec: () => {
            execCalls += 1;
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        deploymentState,
        now: () => 30,
      },
      applying,
      journal,
    );
    expect(execCalls).toBe(0);
    expect(final).toMatchObject([{ outcome: "succeeded" }]);

    rmSync(verifyPath, { recursive: true, force: true });
    final = [];
    await resumeStagedDeploy(
      {
        fx: {
          targets,
          probe: () => true,
          exec: () => {
            execCalls += 1;
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        deploymentState,
        now: () => 40,
      },
      {
        ...applying,
        executionPhase: "ledger_pending",
        provisionalOutcomes: [
          {
            action: "add",
            key: task.key,
            target: "claude",
            outcome: "succeeded",
            attemptedAt: 20,
          },
        ],
      },
      journal,
    );
    expect(execCalls).toBe(0);
    expect(final).toMatchObject([{ outcome: "failed", code: "recovery_state_changed" }]);
  });

  test("keeps successful targets factual when another staged target fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-partial-target-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    mkdirSync(join(homes.agentsHome, ".."), { recursive: true });
    writeFileSync(homes.agentsHome, "blocks the Codex skill root");
    const stagedContent = "---\ndescription: staged\n---\nstaged\n";
    const files = [stagedText(stagedContent)];
    const renderedHash = hashSkillFiles(files.map(stagedSkillFile));
    const claudeTask: StagedSkillTask = {
      type: "skill",
      action: "add",
      key: { kind: "skill", name: "alpha" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash,
      files,
    };
    const codexTask: StagedSkillTask = { ...claudeTask, target: "codex" };
    const baseAction: DeployPlan["actions"][number] = {
      action: claudeTask.action,
      key: claudeTask.key,
      target: claudeTask.target,
      sourceId: claudeTask.sourceId,
      contentSha: claudeTask.contentSha,
      renderedHash: claudeTask.renderedHash,
      artifact: { existence: "missing", hash: null },
    };
    const codexAction: DeployPlan["actions"][number] = {
      ...baseAction,
      target: "codex",
    };
    const deployPlan = plan({ actions: [baseAction, codexAction], mirrors: [] }, baseAction);
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const { coordinator, operations } = coordinatorFixture({
      deployPlan,
      stage: () => ({
        tasks: [codexTask, claudeTask],
        metadata: {},
      }),
      execute: (operation, record) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 20,
          },
          operation,
          record,
        ),
    });

    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await coordinator.wait(operationId);

    expect(readFileSync(join(homes.claudeHome, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
      stagedContent,
    );
    expect(operations.read(operationId)).toMatchObject({
      state: "failed",
      outcomes: [
        { target: "codex", outcome: "failed", code: "io" },
        { target: "claude", outcome: "succeeded" },
      ],
    });
    expect(deploymentState.read(baseAction.key, "claude")?.lastAttempt.outcome).toBe("succeeded");
    expect(deploymentState.read(baseAction.key, "codex")?.lastAttempt).toMatchObject({
      outcome: "failed",
      code: "io",
    });
    expect(readLedger(targets)).toMatchObject({ agents: ["claude"], skills: [{ name: "alpha" }] });
  });

  test("preserves Ledger ownership until the last applied target removal succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-partial-removal-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    mergeLedger(
      targets,
      {
        kitVersion: "",
        targets: ["claude", "codex"],
        skills: ["alpha"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const state = openDeploymentStateStore(targets.deploymentStatePath(), { now: () => 10 });
    for (const target of ["claude", "codex"] as const) {
      state.recordSuccess(
        { kind: "skill", name: "alpha" },
        target,
        {
          sourceId: "source-a",
          contentSha: "a".repeat(64),
          renderedHash: "b".repeat(64),
          appliedAt: 10,
        },
        "seed",
      );
    }
    const claudeAction: DeployPlan["actions"][number] = {
      action: "remove",
      key: { kind: "skill", name: "alpha" },
      target: "claude",
      artifact: { existence: "present", hash: "old" },
    };
    const codexAction = { ...claudeAction, target: "codex" as const };
    const firstPlan = plan({ actions: [claudeAction, codexAction], mirrors: [] }, claudeAction);
    const failingState = {
      ...state,
      recordRemoval: (
        key: Parameters<typeof state.recordRemoval>[0],
        target: Parameters<typeof state.recordRemoval>[1],
        operationId: string,
      ) => {
        if (target === "codex") throw new Error("Codex removal state unavailable");
        return state.recordRemoval(key, target, operationId);
      },
    };
    const first = coordinatorFixture({
      deployPlan: firstPlan,
      stage: () => ({
        tasks: [
          {
            type: "remove",
            action: "remove",
            key: { kind: "skill", name: "alpha" },
            target: "claude",
          },
          {
            type: "remove",
            action: "remove",
            key: { kind: "skill", name: "alpha" },
            target: "codex",
          },
        ],
        metadata: {},
      }),
      execute: (operation, record) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState: failingState,
            now: () => 20,
          },
          operation,
          record,
        ),
    });

    const accepted = await first.coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await first.coordinator.wait(accepted.operationId);
    expect(first.operations.read(accepted.operationId)).toMatchObject({
      state: "failed",
      executionPhase: "finalizing",
      provisionalOutcomes: [
        { target: "claude", outcome: "succeeded" },
        { target: "codex", outcome: "succeeded" },
      ],
      outcomes: [],
    });
    expect(readLedger(targets)?.skills).toEqual([]);

    const retryPlan = plan({ actions: [codexAction], mirrors: [] }, codexAction);
    const retry = coordinatorFixture({
      deployPlan: retryPlan,
      stage: () => ({
        tasks: [
          {
            type: "remove",
            action: "remove",
            key: { kind: "skill", name: "alpha" },
            target: "codex",
          },
        ],
        metadata: {},
      }),
      execute: (operation, record) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState: state,
            now: () => 30,
          },
          operation,
          record,
        ),
    });
    const retried = await retry.coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await retry.coordinator.wait(retried.operationId);
    expect(retry.operations.read(retried.operationId)?.state).toBe("completed");
    expect(readLedger(targets)?.skills).toEqual([]);
  });

  test("preserves imported Ledger ownership while only one target is removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-imported-target-removal-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    mergeLedger(
      targets,
      {
        kitVersion: "",
        targets: ["claude", "codex"],
        skills: ["alpha"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    deploymentState.recordFailure(
      { kind: "skill", name: "alpha" },
      "codex",
      { action: "remove", code: "io", detail: "prior removal failed" },
      "failed-codex-removal",
    );
    const deployRemoval = async (target: "claude" | "codex"): Promise<void> => {
      const action = {
        action: "remove",
        key: { kind: "skill", name: "alpha" },
        target,
        removalIntentGeneration: `intent-${target}`,
        artifact: { existence: "present", hash: "legacy" },
      } satisfies DeployPlan["actions"][number];
      const deployPlan = plan({ actions: [action], mirrors: [] }, action);
      const run = coordinatorFixture({
        deployPlan,
        stage: () => ({
          tasks: [{ type: "remove", action: "remove", key: action.key, target }],
          metadata: {},
        }),
        execute: (operation, journal) =>
          executeStagedDeploy(
            {
              fx: {
                targets,
                exec: () => ({ status: 0, stdout: "", stderr: "" }),
                probe: () => false,
              },
              deploymentState,
              now: () => 20,
            },
            operation,
            journal,
          ),
      });
      const accepted = await run.coordinator.accept({
        selectionRevision: 7,
        planToken: "token-current",
      });
      await run.coordinator.wait(accepted.operationId);
      expect(run.operations.read(accepted.operationId)?.state).toBe("completed");
    };

    await deployRemoval("claude");
    expect(readLedger(targets)?.skills).toEqual([{ name: "alpha" }]);
    expect(deploymentState.read({ kind: "skill", name: "alpha" }, "claude")?.applied).toBe(
      undefined,
    );

    await deployRemoval("codex");
    expect(readLedger(targets)?.skills).toEqual([]);
  });

  test("continues staged tasks when Deployment State failure recording also fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-state-failure-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const stagedContent = "---\ndescription: staged\n---\nstaged\n";
    const files = [stagedText(stagedContent)];
    const renderedHash = hashSkillFiles(files.map(stagedSkillFile));
    const tasks: StagedSkillTask[] = ["alpha", "beta"].map((name) => ({
      type: "skill",
      action: "add",
      key: { kind: "skill", name },
      target: "claude",
      sourceId: "source-a",
      contentSha: name === "alpha" ? "a".repeat(64) : "b".repeat(64),
      renderedHash,
      files,
    }));
    const actions: DeployPlan["actions"] = tasks.map((task) => ({
      action: task.action,
      key: task.key,
      target: task.target,
      sourceId: task.sourceId,
      contentSha: task.contentSha,
      renderedHash: task.renderedHash,
      artifact: { existence: "missing", hash: null },
    }));
    const firstAction = actions[0];
    if (!firstAction) throw new Error("missing fixture action");
    const deployPlan = plan({ actions, mirrors: [] }, firstAction);
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
      rename: () => {
        throw new Error("state persistence unavailable");
      },
    });
    const { coordinator, operations } = coordinatorFixture({
      deployPlan,
      stage: () => ({
        tasks,
        metadata: {},
      }),
      execute: (operation, record) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState,
            now: () => 20,
          },
          operation,
          record,
        ),
    });

    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await coordinator.wait(operationId);

    expect(readFileSync(join(homes.claudeHome, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
      stagedContent,
    );
    expect(readFileSync(join(homes.claudeHome, "skills", "beta", "SKILL.md"), "utf8")).toBe(
      stagedContent,
    );
    expect(operations.read(operationId)).toMatchObject({
      state: "failed",
      executionPhase: "finalizing",
      provisionalOutcomes: [
        { key: { name: "alpha" }, outcome: "succeeded" },
        { key: { name: "beta" }, outcome: "succeeded" },
      ],
      outcomes: [],
    });
    expect(readLedger(targets)?.skills).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  test("restart finalizes a Ledger-committed operation from its durable phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-committed-recovery-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const files = [stagedText("---\ndescription: alpha\n---\nalpha\n")];
    const renderedHash = hashSkillFiles(files.map(stagedSkillFile));
    const action = {
      action: "add",
      key: { kind: "skill", name: "alpha" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash,
      artifact: { existence: "missing", hash: null },
    } satisfies DeployPlan["actions"][number];
    const acceptedPlan = plan({ actions: [action], mirrors: [] }, action);
    const unavailableState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
      rename: () => {
        throw new Error("crash before Deployment State commit");
      },
    });
    const first = coordinatorFixture({
      deployPlan: acceptedPlan,
      stage: () => ({
        tasks: [
          {
            type: "skill",
            action: "add",
            key: action.key,
            target: "claude",
            sourceId: "source-a",
            contentSha: "a".repeat(64),
            renderedHash,
            files,
          },
        ],
        metadata: {},
      }),
      execute: (operation, journal) =>
        executeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState: unavailableState,
            now: () => 20,
          },
          operation,
          journal,
        ),
    });
    const accepted = await first.coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await first.coordinator.wait(accepted.operationId);
    expect(readLedger(targets)?.skills).toEqual([{ name: "alpha" }]);
    expect(first.operations.read(accepted.operationId)).toMatchObject({
      state: "failed",
      executionPhase: "finalizing",
      outcomes: [],
    });

    const recoveredState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 30,
    });
    const reopened = openDeployOperationStore(first.operations.path, { now: () => 30 });
    const scheduled: Array<() => void> = [];
    const nextPlan = plan({ selectionRevision: 8, actions: [], mirrors: [] });
    const restarted = createDeployCoordinator({
      mutationCoordinator: createDeploymentMutationCoordinator(),
      operations: reopened,
      capture: () => ({ snapshot: snapshot(nextPlan), plan: nextPlan }),
      tokenForPlan: () => "token-next",
      stage: () => {
        throw new Error("stale request must not stage a new operation");
      },
      execute: async () => {
        throw new Error("recovery must not reapply filesystem tasks");
      },
      resume: (operation, journal) =>
        resumeStagedDeploy(
          {
            fx: {
              targets,
              exec: () => ({ status: 0, stdout: "", stderr: "" }),
              probe: () => false,
            },
            deploymentState: recoveredState,
            now: () => 30,
          },
          operation,
          journal,
        ),
      onAccepted: () => Promise.resolve(),
      clearRemovalIntents: () => Promise.resolve(),
      schedule: (task) => scheduled.push(task),
    });

    await expect(
      restarted.accept({ selectionRevision: 7, planToken: "token-current" }),
    ).rejects.toMatchObject({ code: "plan_stale" });
    expect(reopened.read(accepted.operationId)).toMatchObject({
      state: "completed",
      executionPhase: "finished",
      outcomes: [{ outcome: "succeeded", target: "claude" }],
    });
    expect(recoveredState.read(action.key, action.target)?.applied).toMatchObject({
      operationId: accepted.operationId,
      renderedHash,
    });
  });

  test("fails a durably queued operation without execution when acceptance audit persistence fails", async () => {
    const scheduled: Array<() => void> = [];
    const { coordinator, operations } = coordinatorFixture({
      schedule: (task) => scheduled.push(task),
      onAccepted: async () => {
        throw new Error("audit unavailable");
      },
    });

    await expect(
      coordinator.accept({ selectionRevision: 7, planToken: "token-current" }),
    ).rejects.toThrow("audit unavailable");
    expect(scheduled).toHaveLength(0);
    expect(operations.read("operation-1")).toMatchObject({
      state: "failed",
      errorCode: "audit_failed",
    });
  });

  test("does not schedule execution until the acceptance audit is durable", async () => {
    const scheduled: Array<() => void> = [];
    let releaseAudit: (() => void) | undefined;
    let markAuditStarted: (() => void) | undefined;
    const audit = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    const { coordinator, operations } = coordinatorFixture({
      schedule: (task) => scheduled.push(task),
      onAccepted: () => {
        markAuditStarted?.();
        return audit;
      },
    });

    const accepting = coordinator.accept({ selectionRevision: 7, planToken: "token-current" });
    await auditStarted;
    expect(operations.read("operation-1")?.state).toBe("queued");
    expect(scheduled).toHaveLength(0);

    releaseAudit?.();
    await expect(accepting).resolves.toEqual({ operationId: "operation-1" });
    expect(scheduled).toHaveLength(1);
  });

  test("persists and executes the canonical instructionWrites operation directly", async () => {
    const instructionAction: DeployPlan["actions"][number] = {
      action: "update",
      key: { kind: "instruction", name: "rules-a" },
      target: "claude",
      sourceId: "source-a",
      contentSha: "a".repeat(64),
      renderedHash: "c".repeat(64),
      artifact: { existence: "present", hash: "old" },
    };
    const deployPlan = plan(
      {
        actions: [instructionAction],
        instructionWrites: [
          {
            target: "claude",
            contributions: [
              {
                key: { kind: "instruction", name: "rules-a" },
                sourceId: "source-a",
                contentSha: "a".repeat(64),
              },
              {
                key: { kind: "instruction", name: "rules-b" },
                sourceId: "source-a",
                contentSha: "b".repeat(64),
              },
            ],
            renderedHash: "c".repeat(64),
            artifact: { existence: "present", hash: "old" },
          },
        ],
      },
      instructionAction,
    );
    let executedContributions: string[] = [];
    const { coordinator, operations } = coordinatorFixture({
      deployPlan,
      stage: (_snapshot, acceptedPlan) =>
        staged(
          acceptedPlan.instructionWrites[0]?.contributions
            .map((contribution) => contribution.key.name)
            .join("+") ?? "",
        ),
      execute: async (operation, record) => {
        executedContributions =
          operation.plan.instructionWrites[0]?.contributions.map(
            (contribution) => contribution.key.name,
          ) ?? [];
        await record([successOutcome(operation)]);
      },
    });

    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await coordinator.wait(operationId);

    expect(operations.read(operationId)?.staged.metadata.value).toBe("rules-a+rules-b");
    expect(executedContributions).toEqual(["rules-a", "rules-b"]);
  });

  test("records partial target failure and clears only successfully removed target intents", async () => {
    const removeClaude: DeployPlan["actions"][number] = {
      action: "remove",
      key: { kind: "skill", name: "old" },
      target: "claude",
      removalIntentGeneration: "intent-claude",
      artifact: { existence: "present", hash: "old-claude" },
    };
    const removeCodex: DeployPlan["actions"][number] = {
      ...removeClaude,
      target: "codex",
      removalIntentGeneration: "intent-codex",
      artifact: { existence: "present", hash: "old-codex" },
    };
    const cleared: Array<{
      key: DeployPlan["actions"][number]["key"];
      target: DeployTarget;
      generation: string;
    }> = [];
    const { coordinator, operations } = coordinatorFixture({
      deployPlan: plan({ actions: [removeClaude, removeCodex] }, removeClaude),
      execute: async (_operation, record) => {
        await record([
          {
            action: "remove",
            key: removeClaude.key,
            target: "claude",
            outcome: "succeeded",
            attemptedAt: 20,
          },
          {
            action: "remove",
            key: removeCodex.key,
            target: "codex",
            outcome: "failed",
            attemptedAt: 21,
            code: "io",
          },
        ]);
      },
      clearRemovalIntents: async (entries) => {
        cleared.push(...entries);
      },
    });

    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await coordinator.wait(operationId);

    expect(operations.read(operationId)).toMatchObject({
      state: "failed",
      outcomes: [
        { target: "claude", outcome: "succeeded" },
        { target: "codex", outcome: "failed", code: "io" },
      ],
    });
    expect(cleared).toEqual([
      {
        key: { kind: "skill", name: "old" },
        target: "claude",
        generation: "intent-claude",
      },
    ]);
  });

  test("emits exactly one refs-only acceptance audit event and no transition duplicates", async () => {
    const events: unknown[] = [];
    const { coordinator } = coordinatorFixture({
      onAccepted: async (event) => {
        events.push(event);
      },
    });

    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });
    await coordinator.wait(operationId);

    expect(events).toEqual([
      {
        operationId,
        selectionRevision: 7,
        perKindActionCounts: { skill: 1 },
        targetClis: ["claude"],
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("accepted");
    expect(JSON.stringify(events)).not.toContain("contentSha");
  });

  test("operation summaries expose active and last durable truth", async () => {
    const scheduled: Array<() => void> = [];
    const { coordinator, operations } = coordinatorFixture({
      schedule: (task) => scheduled.push(task),
    });
    const { operationId } = await coordinator.accept({
      selectionRevision: 7,
      planToken: "token-current",
    });

    expect(operations.activeSummary()).toEqual({
      operationId,
      state: "queued",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
    });
    expect(operations.lastSummary()).toEqual({
      operationId,
      state: "queued",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
    });

    scheduled[0]?.();
    await coordinator.wait(operationId);
    expect(operations.activeSummary()).toBeNull();
    expect(operations.lastSummary()).toMatchObject({
      operationId,
      state: "completed",
      completedAt: 10,
    });
  });

  test("compacts terminal summaries and staged payload files without pruning active recovery data", () => {
    const path = operationPath();
    const store = openDeployOperationStore(path, {
      now: () => 10,
      summaryRetention: 2,
      payloadRetention: 1,
    } as Parameters<typeof openDeployOperationStore>[1] & {
      summaryRetention: number;
      payloadRetention: number;
    });
    for (let index = 1; index <= 4; index += 1) {
      const operationId = `terminal-${index}`;
      store.createQueued({
        operationId,
        acceptedAt: index,
        selectionRevision: index,
        planToken: `token-${index}`,
        plan: plan({ selectionRevision: index }),
        staged: staged("x".repeat(64_000)),
      });
      const running = store.markRunning(operationId);
      store.recordOutcomes(operationId, [successOutcome(running)]);
      store.finish(operationId, "completed");
    }
    store.createQueued({
      operationId: "active-recovery",
      acceptedAt: 5,
      selectionRevision: 5,
      planToken: "token-active",
      plan: plan({ selectionRevision: 5 }),
      staged: staged("active".repeat(20_000)),
    });

    const index = JSON.parse(readFileSync(path, "utf8")) as { operations: unknown[] };
    expect(index.operations).toHaveLength(3);
    const payloadDirectory = join(path, "..", "operations.payloads");
    expect(readdirSync(payloadDirectory)).toHaveLength(2);
    expect(store.read("terminal-1")).toBeUndefined();
    expect(store.read("active-recovery")?.staged.metadata.value).toContain("active");
  });

  test("sweeps crash-left payload temp files while the operation store is locked", () => {
    const path = operationPath();
    const payloadDirectory = join(path, "..", "operations.payloads");
    mkdirSync(payloadDirectory, { recursive: true });
    const crashRemnant = join(payloadDirectory, "payload.json.tmp-123-crashed");
    writeFileSync(crashRemnant, "x".repeat(64_000));

    openDeployOperationStore(path);

    expect(existsSync(crashRemnant)).toBe(false);
    expect(readdirSync(payloadDirectory)).toEqual([]);
  });

  test("reopening queued and running operations interrupts them and reports unfinished actions", () => {
    for (const state of ["queued", "running"] as const) {
      const path = operationPath();
      const initial = openDeployOperationStore(path, { now: () => 10 });
      initial.createQueued({
        operationId: `operation-${state}`,
        acceptedAt: 10,
        selectionRevision: 7,
        planToken: "token-current",
        plan: plan(),
        staged: staged(),
      });
      if (state === "running") initial.markRunning(`operation-${state}`);
      const interrupted: DeployOperation[] = [];

      const reopened = openDeployOperationStore(path, {
        now: () => 30,
        onInterrupted: (operation) => interrupted.push(operation),
      });

      expect(reopened.read(`operation-${state}`)).toMatchObject({
        state: "interrupted",
        completedAt: 30,
      });
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]?.plan.actions).toEqual(plan().actions);
    }
  });

  test("a crashed pathname-lock owner cannot block restart recovery", async () => {
    const path = operationPath();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { openSync, writeSync } from "node:fs";
const fd = openSync(process.env.CRASH_LOCK_PATH, "wx", 0o600);
writeSync(fd, String(process.pid));
process.kill(process.pid, "SIGKILL");`,
      ],
      { env: { ...process.env, CRASH_LOCK_PATH: `${path}.lock` }, stderr: "pipe" },
    );
    await child.exited;
    expect(existsSync(`${path}.lock`)).toBe(true);

    expect(() => openDeployOperationStore(path, { lockTimeoutMs: 25 })).not.toThrow();
  });

  test("the advisory transaction lock is OS-released after a real owner crash", async () => {
    const path = operationPath();
    const moduleUrl = new URL("../../lib/durable-file.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { withAdvisoryFileLock } = await import(process.env.LOCK_MODULE_URL);
withAdvisoryFileLock(process.env.OP_PATH, 5000, () => {
  process.kill(process.pid, "SIGKILL");
});`,
      ],
      {
        env: { ...process.env, LOCK_MODULE_URL: moduleUrl, OP_PATH: path },
        stderr: "pipe",
      },
    );
    await child.exited;

    expect(() => openDeployOperationStore(path, { lockTimeoutMs: 100 })).not.toThrow();
    expect(openDeployOperationStore(path).list()).toEqual([]);
  });

  test("concurrent process writers serialize to one active operation", async () => {
    const path = operationPath();
    const root = join(path, "..");
    const go = join(root, "go");
    const moduleUrl = new URL("../deploy-operations.ts", import.meta.url).href;
    const input = JSON.stringify({
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
      auditState: "recorded",
    });
    const children = ["first", "second"].map((id) => {
      const ready = join(root, `${id}.ready`);
      const result = join(root, `${id}.result`);
      const code = `import { existsSync, writeFileSync } from "node:fs";
const { openDeployOperationStore } = await import(process.env.OP_MODULE_URL);
const store = openDeployOperationStore(process.env.OP_PATH);
writeFileSync(process.env.READY_PATH, "ready");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(process.env.GO_PATH)) Atomics.wait(wait, 0, 0, 5);
try {
  store.createQueued({ ...JSON.parse(process.env.OP_INPUT), operationId: process.env.OP_ID });
  writeFileSync(process.env.RESULT_PATH, "accepted");
} catch (error) {
  writeFileSync(process.env.RESULT_PATH, error?.code ?? "error");
}`;
      return {
        ready,
        result,
        child: Bun.spawn([process.execPath, "-e", code], {
          env: {
            ...process.env,
            OP_MODULE_URL: moduleUrl,
            OP_PATH: path,
            OP_INPUT: input,
            OP_ID: `operation-${id}`,
            READY_PATH: ready,
            RESULT_PATH: result,
            GO_PATH: go,
          },
          stderr: "pipe",
        }),
      };
    });
    for (
      let attempt = 0;
      attempt < 100 && children.some((item) => !existsSync(item.ready));
      attempt += 1
    ) {
      await Bun.sleep(5);
    }
    expect(children.every((item) => existsSync(item.ready))).toBe(true);
    writeFileSync(go, "go");
    await Promise.all(children.map((item) => item.child.exited));

    expect(children.map((item) => readFileSync(item.result, "utf8")).sort()).toEqual([
      "accepted",
      "operation_active",
    ]);
    expect(openDeployOperationStore(path).list()).toHaveLength(1);
  });

  test("pending audit recovery fails without execution and recorded audit transition is idempotent", () => {
    const path = operationPath();
    const store = openDeployOperationStore(path, { now: () => 10 });
    store.createQueued({
      operationId: "operation-pending-audit",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
      auditState: "pending",
    });
    let recoveryCalls = 0;
    const recoveredPending = openDeployOperationStore(path, {
      now: () => 20,
      onInterrupted: () => {
        recoveryCalls += 1;
      },
    });
    expect(recoveredPending.read("operation-pending-audit")).toMatchObject({
      state: "failed",
      errorCode: "audit_interrupted",
      auditState: "pending",
    });
    expect(recoveryCalls).toBe(0);

    store.createQueued({
      operationId: "operation-recorded-audit",
      acceptedAt: 30,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
      auditState: "pending",
    });
    expect(store.markAuditRecorded("operation-recorded-audit").auditState).toBe("recorded");
    expect(store.markAuditRecorded("operation-recorded-audit").auditState).toBe("recorded");
    const recoveredRecorded = openDeployOperationStore(path, { now: () => 40 });
    expect(recoveredRecorded.read("operation-recorded-audit")?.state).toBe("interrupted");
  });

  test("recovery marking failures stay pending, do not abort startup, and replay once", () => {
    const path = operationPath();
    const baseAction = plan().actions[0];
    if (!baseAction) throw new Error("missing fixture action");
    const actions: DeployPlan["actions"] = [baseAction, { ...baseAction, target: "codex" }];
    const codexAction = actions[1];
    if (!codexAction) throw new Error("missing Codex fixture action");
    const initial = openDeployOperationStore(path, { now: () => 10 });
    initial.createQueued({
      operationId: "operation-recovery",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan({ actions }),
      staged: staged(),
    });
    const recoveryState = openDeploymentStateStore(join(path, "..", "recovery-state.json"), {
      now: () => 30,
    });
    const firstCalls: DeployTarget[] = [];

    expect(() =>
      openDeployOperationStore(path, {
        now: () => 30,
        onInterrupted: (operation) => {
          const target = operation.unfinishedActions?.[0]?.target;
          if (!target) throw new Error("missing recovery action");
          firstCalls.push(target);
          markInterruptedDeploymentState(recoveryState, operation);
          if (target === "codex") throw new Error("state unavailable");
        },
      }),
    ).not.toThrow();
    expect(firstCalls).toEqual(["claude", "codex"]);
    expect(
      openDeployOperationStore(path).read("operation-recovery")?.recoveryPendingActions,
    ).toEqual([codexAction]);
    const revisionAfterCrashWindow = recoveryState.readAll().revision;

    const replayed: DeployTarget[] = [];
    const recovered = openDeployOperationStore(path, {
      onInterrupted: (operation) => {
        const target = operation.unfinishedActions?.[0]?.target;
        if (target) replayed.push(target);
        markInterruptedDeploymentState(recoveryState, operation);
      },
    });
    expect(replayed).toEqual(["codex"]);
    expect(recovered.read("operation-recovery")?.recoveryPendingActions).toEqual([]);
    expect(recoveryState.readAll().revision).toBe(revisionAfterCrashWindow);

    openDeployOperationStore(path, {
      onInterrupted: () => {
        throw new Error("acknowledged work must not replay");
      },
    });
  });

  test("recovery receipt preserves a newer attempt after mark succeeds but acknowledgement fails", () => {
    const path = operationPath();
    const action = plan().actions[0];
    if (!action) throw new Error("missing fixture action");
    const initial = openDeployOperationStore(path, { now: () => 10 });
    initial.createQueued({
      operationId: "operation-old",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
    });
    const recoveryState = openDeploymentStateStore(join(path, "..", "recovery-state.json"), {
      now: () => 20,
    });

    openDeployOperationStore(path, {
      now: () => 20,
      onInterrupted: (operation) => {
        markInterruptedDeploymentState(recoveryState, operation);
        throw new Error("crash before operation-store acknowledgement");
      },
    });
    expect(openDeployOperationStore(path).read("operation-old")?.recoveryPendingActions).toEqual([
      action,
    ]);
    expect(recoveryState.readAll().interruptionReceipts).toContainEqual({
      key: action.key,
      target: action.target,
      action: action.action,
      operationId: "operation-old",
    });
    recoveryState.recordSuccess(
      action.key,
      action.target,
      {
        sourceId: "source-new",
        contentSha: "c".repeat(64),
        renderedHash: "d".repeat(64),
        appliedAt: 30,
      },
      "operation-new",
    );
    const newerAttempt = recoveryState.read(action.key, action.target);
    const revisionAfterNewerAttempt = recoveryState.readAll().revision;

    const recovered = openDeployOperationStore(path, {
      now: () => 40,
      onInterrupted: (operation) => markInterruptedDeploymentState(recoveryState, operation),
    });

    expect(recovered.read("operation-old")?.recoveryPendingActions).toEqual([]);
    expect(recoveryState.read(action.key, action.target)).toEqual(newerAttempt);
    expect(recoveryState.readAll().revision).toBe(revisionAfterNewerAttempt);
  });

  test("running and terminal transitions retry bounded transient durable write failures", () => {
    const path = operationPath();
    let failuresRemaining = 0;
    const store = openDeployOperationStore(path, {
      now: () => 10,
      rename: (from, to) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("transient rename failure");
        }
        renameSync(from, to);
      },
    });
    store.createQueued({
      operationId: "operation-retry",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
    });

    failuresRemaining = 2;
    expect(store.markRunning("operation-retry").state).toBe("running");
    failuresRemaining = 2;
    expect(store.finish("operation-retry", "failed", "execution_failed")).toMatchObject({
      state: "failed",
      errorCode: "execution_failed",
    });
    expect(store.activeSummary()).toBeNull();
  });

  test("queued creation retry after post-rename fsync failure stays idempotent", () => {
    const path = operationPath();
    let failFsync = true;
    const store = openDeployOperationStore(path, {
      now: () => 10,
      fsyncDirectory: () => {
        if (failFsync) {
          failFsync = false;
          throw new Error("directory fsync interrupted");
        }
      },
    });

    expect(
      store.createQueued({
        operationId: "operation-idempotent-create",
        acceptedAt: 10,
        selectionRevision: 7,
        planToken: "token-current",
        plan: plan(),
        staged: staged(),
      }).operationId,
    ).toBe("operation-idempotent-create");
    expect(store.list().map((operation) => operation.operationId)).toEqual([
      "operation-idempotent-create",
    ]);
  });

  test("persistent transition write failure remains restart-recoverable instead of permanently active", async () => {
    for (const blockedState of ["running", "completed"] as const) {
      const path = operationPath();
      let blockTransitions = false;
      const operations = openDeployOperationStore(path, {
        now: () => 10,
        rename: (from, to) => {
          const pending = readFileSync(from, "utf8");
          if (
            blockTransitions &&
            (pending.includes(`"state": "${blockedState}"`) ||
              pending.includes('"state": "failed"'))
          ) {
            throw new Error("persistent transition failure");
          }
          renameSync(from, to);
        },
      });
      const coordinator = createDeployCoordinator({
        mutationCoordinator: createDeploymentMutationCoordinator(),
        operations,
        capture: () => ({ snapshot: snapshot(), plan: plan() }),
        tokenForPlan: () => "token-current",
        stage: () => staged(),
        execute: async (operation, record) => {
          await record([successOutcome(operation)]);
          if (blockedState === "completed") blockTransitions = true;
        },
        onAccepted: async () => {
          if (blockedState === "running") blockTransitions = true;
        },
        clearRemovalIntents: () => Promise.resolve(),
        operationId: () => `operation-${blockedState}`,
        now: () => 10,
      });

      const accepted = await coordinator.accept({
        selectionRevision: 7,
        planToken: "token-current",
      });
      await coordinator.wait(accepted.operationId);
      expect(operations.activeSummary()?.operationId).toBe(accepted.operationId);

      blockTransitions = false;
      const restarted = openDeployOperationStore(path, { now: () => 20 });
      expect(restarted.activeSummary()).toBeNull();
      expect(restarted.read(accepted.operationId)?.state).toBe("interrupted");
    }
  });

  test("restart recovery excludes already-recorded outcomes from interruption marking", () => {
    const path = operationPath();
    const baseAction = plan().actions[0];
    if (!baseAction) throw new Error("missing fixture action");
    const actions: DeployPlan["actions"] = [baseAction, { ...baseAction, target: "codex" }];
    const initial = openDeployOperationStore(path, { now: () => 10 });
    initial.createQueued({
      operationId: "operation-running",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan({ actions }),
      staged: staged(),
    });
    initial.markRunning("operation-running");
    initial.recordOutcomes("operation-running", [
      {
        action: "add",
        key: { kind: "skill", name: "alpha" },
        target: "claude",
        outcome: "succeeded",
        attemptedAt: 20,
      },
    ]);
    const interrupted: DeployOperation[] = [];

    openDeployOperationStore(path, {
      now: () => 30,
      onInterrupted: (operation) => interrupted.push(operation),
    });

    const unfinished = actions[1];
    if (!unfinished) throw new Error("missing fixture action");
    expect(interrupted[0]?.unfinishedActions).toEqual([unfinished]);
  });

  test("restart recovery marks every unfinished target action interrupted in Deployment State", () => {
    const path = operationPath();
    const state = openDeploymentStateStore(join(path, "..", "deployment-state.json"), {
      now: () => 30,
    });
    const initial = openDeployOperationStore(path, { now: () => 10 });
    initial.createQueued({
      operationId: "operation-interrupted",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
    });

    openDeployOperationStore(path, {
      now: () => 30,
      onInterrupted: (operation) => markInterruptedDeploymentState(state, operation),
    });

    expect(state.read({ kind: "skill", name: "alpha" }, "claude")?.lastAttempt).toEqual({
      action: "add",
      outcome: "interrupted",
      attemptedAt: 30,
      operationId: "operation-interrupted",
    });
  });

  test("operation persistence handles partial writes atomically and stale store handles cannot overwrite", () => {
    const path = operationPath();
    const first = openDeployOperationStore(path, {
      now: () => 10,
      write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, Math.min(length, 3)),
    });
    const staleHandle = openDeployOperationStore(path, { now: () => 10 });
    first.createQueued({
      operationId: "operation-first",
      acceptedAt: 10,
      selectionRevision: 7,
      planToken: "token-current",
      plan: plan(),
      staged: staged(),
    });

    expect(() =>
      staleHandle.createQueued({
        operationId: "operation-collision",
        acceptedAt: 11,
        selectionRevision: 8,
        planToken: "token-next",
        plan: plan({ selectionRevision: 8 }),
        staged: staged("collision"),
      }),
    ).toThrow(expect.objectContaining({ code: "operation_active" }));
    expect(openDeployOperationStore(path).read("operation-first")).toMatchObject({
      state: "interrupted",
      plan: { selectionRevision: 7 },
    });
    expect(() =>
      staleHandle.createQueued({
        operationId: "operation-second",
        acceptedAt: 11,
        selectionRevision: 8,
        planToken: "token-next",
        plan: plan({ selectionRevision: 8 }),
        staged: staged("next"),
      }),
    ).not.toThrow();
    expect(
      openDeployOperationStore(path)
        .list()
        .map((operation) => operation.operationId),
    ).toEqual(["operation-first", "operation-second"]);
    expect(readdirSync(join(path, "..")).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("the same mutation coordinator serializes Source sync/mirror mutation against acceptance", async () => {
    const mutationCoordinator = createDeploymentMutationCoordinator();
    const operations = openDeployOperationStore(operationPath(), { now: () => 10 });
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const order: string[] = [];
    const coordinator = createDeployCoordinator({
      mutationCoordinator,
      operations,
      capture: async () => {
        order.push("accept:start");
        await captureGate;
        order.push("accept:end");
        const deployPlan = plan();
        return { snapshot: snapshot(deployPlan), plan: deployPlan };
      },
      tokenForPlan: () => "token-current",
      stage: () => staged(),
      execute: async (operation, record) => record([successOutcome(operation)]),
      onAccepted: () => Promise.resolve(),
      clearRemovalIntents: () => Promise.resolve(),
      operationId: () => "operation-1",
      now: () => 10,
    });

    const accepting = coordinator.accept({ selectionRevision: 7, planToken: "token-current" });
    await Promise.resolve();
    const syncing = mutationCoordinator.runExclusive(async () => {
      order.push("sync");
    });
    await Promise.resolve();
    expect(order).toEqual(["accept:start"]);

    releaseCapture?.();
    await accepting;
    await syncing;
    expect(order).toEqual(["accept:start", "accept:end", "accept:start", "accept:end", "sync"]);
  });
});
