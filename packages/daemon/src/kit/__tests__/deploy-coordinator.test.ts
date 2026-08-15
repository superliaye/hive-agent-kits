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
import { join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import { withCooperativeFileLock } from "../../lib/durable-file.ts";
import { mirrorContentSha } from "../content-sha.ts";
import { hashSkillFiles } from "../deploy/artifact-hash.ts";
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
} from "../deploy-operations.ts";
import type { DeploymentSnapshot, DeployPlan } from "../deploy-plan.ts";
import { openDeploymentStateStore } from "../deployment-state.ts";
import { mergeLedger, readLedger } from "../ledger.ts";
import { readMirrorIdentity } from "../overview.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

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
    sources: [{ id: "source-a", label: "Source A", kind: "git", active: true, rank: 1 }],
    sourceRegistryRevision: deployPlan.sourceRegistryRevision,
    mirrors: deployPlan.mirrors,
    catalog: { entries: [], presets: [], problems: [] },
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
      legacyInstructionFingerprints: [],
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
    const renderedHash = hashSkillFiles([{ rel: "SKILL.md", content: acceptedContent }]);
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

  test("keeps filesystem success provisional when the real Ledger commit fails", async () => {
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
    const files = [{ rel: "SKILL.md", content: "---\ndescription: staged\n---\nstaged\n" }];
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
          renderedHash: hashSkillFiles(files),
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

    expect(readFileSync(join(homes.claudeHome, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
      files[0]?.content ?? "",
    );
    expect(deploymentState.read(action.key, action.target)?.applied).toBeUndefined();
    expect(operations.read(operation.operationId)?.outcomes).toEqual([]);
  });

  test("recovers filesystem-only success when the Ledger-pending checkpoint write fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-checkpoint-failure-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const files = [{ rel: "SKILL.md", content: "---\ndescription: alpha\n---\nalpha\n" }];
    const renderedHash = hashSkillFiles(files);
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

  test("restart retries one shared Ledger-pending recovery after a real lock timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-ledger-lock-recovery-"));
    roots.push(root);
    redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    const deploymentState = openDeploymentStateStore(targets.deploymentStatePath(), {
      now: () => 20,
    });
    const files = [{ rel: "SKILL.md", content: "---\ndescription: alpha\n---\nalpha\n" }];
    const renderedHash = hashSkillFiles(files);
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

  test("rejects a plugin even when its mutable descriptor claims a pinned commit", () => {
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

    expect(() => stageDeployPlan(targets, snapshot(deployPlan), deployPlan)).toThrow(
      expect.objectContaining({ code: "immutable_installer_unavailable" }),
    );
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

  test("keeps successful targets factual when another staged target fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-partial-target-"));
    roots.push(root);
    const homes = redirectHomeEnv(root);
    const targets = failSafeDeployTargets();
    mkdirSync(join(homes.agentsHome, ".."), { recursive: true });
    writeFileSync(homes.agentsHome, "blocks the Codex skill root");
    const stagedContent = "---\ndescription: staged\n---\nstaged\n";
    const files = [{ rel: "SKILL.md", content: stagedContent }];
    const renderedHash = hashSkillFiles(files);
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
    const files = [{ rel: "SKILL.md", content: stagedContent }];
    const renderedHash = hashSkillFiles(files);
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
    const files = [{ rel: "SKILL.md", content: "---\ndescription: alpha\n---\nalpha\n" }];
    const renderedHash = hashSkillFiles(files);
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

  test("compacts terminal v1 history while migrating to per-operation payloads", () => {
    const path = operationPath();
    const legacyPlan = plan();
    const action = legacyPlan.actions[0];
    if (!action) throw new Error("missing fixture action");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        operations: Array.from({ length: 4 }, (_, index) => ({
          operationId: `legacy-terminal-${index + 1}`,
          state: "completed",
          acceptedAt: index + 1,
          completedAt: index + 2,
          selectionRevision: index + 1,
          planToken: `legacy-token-${index + 1}`,
          plan: legacyPlan,
          staged: staged("x".repeat(64_000)),
          auditState: "recorded",
          outcomes: [
            {
              action: action.action,
              key: action.key,
              target: action.target,
              outcome: "succeeded",
              attemptedAt: index + 2,
            },
          ],
          recoveryPendingActions: [],
        })),
      }),
    );

    openDeployOperationStore(path, { summaryRetention: 2, payloadRetention: 1 });

    const migrated = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      operations: Array<{ operationId: string }>;
    };
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.operations.map((operation) => operation.operationId)).toEqual([
      "legacy-terminal-3",
      "legacy-terminal-4",
    ]);
    expect(readdirSync(join(path, "..", "operations.payloads"))).toHaveLength(1);
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

  test("migrates latest recorded v1 outcomes into Ledger recovery", () => {
    const legacyPlan = plan({
      actions: [
        plan().actions[0] as DeployPlan["actions"][number],
        {
          action: "add",
          key: { kind: "skill", name: "beta" },
          target: "claude",
          sourceId: "source-a",
          contentSha: "c".repeat(64),
          renderedHash: "d".repeat(64),
          artifact: { existence: "missing", hash: null },
        },
      ],
    });
    const completedAction = legacyPlan.actions[0];
    if (!completedAction) throw new Error("missing fixture action");
    const completedOutcome = {
      action: completedAction.action,
      key: completedAction.key,
      target: completedAction.target,
      outcome: "succeeded" as const,
      attemptedAt: 20,
    };
    for (const state of ["running", "failed", "interrupted"] as const) {
      const path = operationPath();
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          operations: [
            {
              operationId: `legacy-${state}`,
              state,
              acceptedAt: 10,
              ...(state === "running" ? {} : { completedAt: 20 }),
              selectionRevision: 7,
              planToken: `legacy-token-${state}`,
              plan: legacyPlan,
              staged: staged(),
              auditState: "recorded",
              outcomes: [completedOutcome],
              recoveryPendingActions: [],
              ...(state === "failed" ? { errorCode: "execution_failed" } : {}),
            },
          ],
        }),
      );
      const migrated = openDeployOperationStore(path, { now: () => 30 });
      expect(migrated.read(`legacy-${state}`)).toMatchObject({
        state: state === "running" ? "interrupted" : state,
        executionPhase: "ledger_pending",
        finalizationState: "already_recorded",
        provisionalOutcomes: [completedOutcome],
        outcomes: [],
      });
      expect(migrated.recoverable().map((operation) => operation.operationId)).toEqual([
        `legacy-${state}`,
      ]);
    }
  });

  test("migrates an older recorded v1 outcome when a newer operation is unrelated", () => {
    const path = operationPath();
    const alphaPlan = plan();
    const alphaAction = alphaPlan.actions[0];
    if (!alphaAction) throw new Error("missing alpha fixture action");
    const betaPlan = plan({
      selectionRevision: 8,
      actions: [{ ...alphaAction, key: { kind: "skill", name: "beta" } }],
    });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        operations: [
          {
            operationId: "legacy-alpha-failure",
            state: "failed",
            acceptedAt: 10,
            completedAt: 20,
            selectionRevision: 7,
            planToken: "legacy-token-alpha",
            plan: alphaPlan,
            staged: staged(),
            auditState: "recorded",
            outcomes: [
              {
                action: alphaAction.action,
                key: alphaAction.key,
                target: alphaAction.target,
                outcome: "succeeded",
                attemptedAt: 20,
              },
            ],
            recoveryPendingActions: [],
            errorCode: "execution_failed",
          },
          {
            operationId: "newer-beta-queued",
            state: "queued",
            acceptedAt: 30,
            selectionRevision: 8,
            planToken: "legacy-token-beta",
            plan: betaPlan,
            staged: staged("beta"),
            auditState: "recorded",
            outcomes: [],
            recoveryPendingActions: [],
          },
        ],
      }),
    );

    const migrated = openDeployOperationStore(path, { now: () => 40 });

    expect(migrated.read("legacy-alpha-failure")).toMatchObject({
      state: "failed",
      executionPhase: "ledger_pending",
      finalizationState: "already_recorded",
      provisionalOutcomes: [
        {
          key: { kind: "skill", name: "alpha" },
          target: "claude",
          outcome: "succeeded",
        },
      ],
      outcomes: [],
    });
    expect(migrated.recoverable().map((operation) => operation.operationId)).toEqual([
      "legacy-alpha-failure",
    ]);
  });

  test("does not recover a v1 failure superseded by a newer completed operation", () => {
    const path = operationPath();
    const legacyPlan = plan();
    const action = legacyPlan.actions[0];
    if (!action) throw new Error("missing fixture action");
    const outcome = {
      action: action.action,
      key: action.key,
      target: action.target,
      outcome: "succeeded" as const,
      attemptedAt: 20,
    };
    const operation = (operationId: string, state: "failed" | "completed") => ({
      operationId,
      state,
      acceptedAt: state === "failed" ? 10 : 30,
      completedAt: state === "failed" ? 20 : 40,
      selectionRevision: 7,
      planToken: `legacy-token-${operationId}`,
      plan: legacyPlan,
      staged: staged(),
      auditState: "recorded",
      outcomes: [outcome],
      recoveryPendingActions: [],
      ...(state === "failed" ? { errorCode: "execution_failed" } : {}),
    });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        operations: [operation("old-failure", "failed"), operation("new-success", "completed")],
      }),
    );

    const migrated = openDeployOperationStore(path);

    expect(migrated.recoverable()).toEqual([]);
    expect(migrated.read("old-failure")?.executionPhase).toBe("finished");
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
