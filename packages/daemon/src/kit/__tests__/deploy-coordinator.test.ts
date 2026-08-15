import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import { mirrorContentSha } from "../content-sha.ts";
import { hashSkillFiles } from "../deploy/artifact-hash.ts";
import {
  createDeployCoordinator,
  createDeploymentMutationCoordinator,
  DeployInProgressError,
  executeStagedDeploy,
  markInterruptedDeploymentState,
  PlanStaleError,
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
import { readLedger } from "../ledger.ts";
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
  schedule?: (task: () => void) => void;
  execute?: Parameters<typeof createDeployCoordinator>[0]["execute"];
  stage?: Parameters<typeof createDeployCoordinator>[0]["stage"];
  onAccepted?: Parameters<typeof createDeployCoordinator>[0]["onAccepted"];
  clearRemovalIntents?: Parameters<typeof createDeployCoordinator>[0]["clearRemovalIntents"];
}) {
  const deployPlan = options.deployPlan ?? plan();
  const operations = openDeployOperationStore(operationPath(), { now: () => 10 });
  const coordinator = createDeployCoordinator({
    mutationCoordinator: createDeploymentMutationCoordinator(),
    operations,
    capture: () => ({ snapshot: snapshot(deployPlan), plan: deployPlan }),
    tokenForPlan: () => options.planToken ?? "token-current",
    stage: options.stage ?? (() => staged()),
    execute:
      options.execute ??
      (async (operation, record) => {
        await record([successOutcome(operation)]);
      }),
    onAccepted: options.onAccepted ?? (() => Promise.resolve()),
    clearRemovalIntents: options.clearRemovalIntents ?? (() => Promise.resolve()),
    operationId: () => "operation-1",
    now: () => 10,
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  return { coordinator, operations, deployPlan };
}

describe("persisted asynchronous Deploy coordinator", () => {
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
      outcomes: [
        { key: { name: "alpha" }, outcome: "failed", code: "io" },
        { key: { name: "beta" }, outcome: "failed", code: "io" },
      ],
    });
    expect(readLedger(targets)?.skills).toEqual([]);
  });

  test("starts a durably queued operation even when acceptance audit persistence fails", async () => {
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
    expect(operations.read("operation-1")?.state).toBe("queued");
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    await coordinator.wait("operation-1");
    expect(operations.read("operation-1")?.state).toBe("completed");
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
      artifact: { existence: "present", hash: "old-claude" },
    };
    const removeCodex: DeployPlan["actions"][number] = {
      ...removeClaude,
      target: "codex",
      artifact: { existence: "present", hash: "old-codex" },
    };
    const cleared: Array<{
      key: DeployPlan["actions"][number]["key"];
      targets: DeployTarget[];
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
    expect(cleared).toEqual([{ key: { kind: "skill", name: "old" }, targets: ["claude"] }]);
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
    });
    expect(operations.lastSummary()).toEqual({
      operationId,
      state: "queued",
      acceptedAt: 10,
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
    expect(order).toEqual(["accept:start", "accept:end", "sync"]);
  });
});
