import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeCapabilityKey } from "@hive/capability-schema";
import type { AcceptedDeployRequest, DeployTarget } from "@hive/contract";
import { log } from "../lib/log.ts";
import { mirrorContentSha } from "./content-sha.ts";
import {
  backupIfExists,
  type DeployFsExec,
  readSkillSource,
  removeDir,
  removeFile,
  writeFileAt,
  writeSkillFolder,
} from "./deploy/adapter.ts";
import {
  deployedAgentPath,
  deployedInstructionPath,
  deployedSkillDir,
  hashSkillFiles,
  sha256,
} from "./deploy/artifact-hash.ts";
import {
  agentSourceDir,
  bundleMeta,
  instructionBody,
  loadSnippets,
  pluginMeta,
  skillDisablesModelInvocation,
  skillSourceDir,
} from "./deploy/sources.ts";
import { transformAgent, transformInstructions, transformSkill } from "./deploy/transforms.ts";
import {
  type DeployOperation,
  type DeployOperationOutcome,
  type DeployOperationStore,
  DeployOperationStoreError,
  type StagedDeployPayload,
  type StagedDeployTask,
} from "./deploy-operations.ts";
import { type DeploymentSnapshot, type DeployPlan, ledgerOwnershipByKey } from "./deploy-plan.ts";
import type { DeploymentStateStore } from "./deployment-state.ts";
import { type LedgerWriteOptions, mergeLedger, readLedger } from "./ledger.ts";
import { readMirrorIdentity } from "./overview.ts";
import type { DeployTargets } from "./targets.ts";

export type { StagedDeployPayload } from "./deploy-operations.ts";

export type DeploymentMutationCoordinator = {
  runExclusive<A>(work: () => A | Promise<A>): Promise<A>;
};

export function createDeploymentMutationCoordinator(): DeploymentMutationCoordinator {
  let tail = Promise.resolve();
  return {
    runExclusive: async (work) => {
      const prior = tail;
      let release = (): void => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

export class PlanStaleError extends Error {
  readonly code = "plan_stale";

  constructor() {
    super("plan_stale");
    this.name = "PlanStaleError";
  }
}

export class DeployInProgressError extends Error {
  readonly code = "deploy_in_progress";
  readonly operationId: string;

  constructor(operationId: string) {
    super("deploy_in_progress");
    this.name = "DeployInProgressError";
    this.operationId = operationId;
  }
}

export class ImmutableInstallerStagingError extends Error {
  readonly code = "immutable_installer_unavailable";

  constructor() {
    super("immutable_installer_unavailable");
    this.name = "ImmutableInstallerStagingError";
  }
}

export type DeployAcceptedAudit = {
  operationId: string;
  selectionRevision: number;
  perKindActionCounts: Record<string, number>;
  targetClis: DeployTarget[];
};

type CapturedPlan = {
  snapshot: DeploymentSnapshot;
  plan: DeployPlan;
};

export type CreateDeployCoordinatorOptions = {
  mutationCoordinator: DeploymentMutationCoordinator;
  operations: DeployOperationStore;
  capture(): CapturedPlan | Promise<CapturedPlan>;
  tokenForPlan(plan: DeployPlan): string;
  stage(
    snapshot: DeploymentSnapshot,
    plan: DeployPlan,
  ): StagedDeployPayload | Promise<StagedDeployPayload>;
  execute(operation: DeployOperation, journal: DeployExecutionJournal): Promise<void>;
  resume?(operation: DeployOperation, journal: DeployExecutionJournal): Promise<void>;
  onAccepted(event: DeployAcceptedAudit): Promise<void>;
  clearRemovalIntents(
    entries: readonly {
      key: DeployPlan["actions"][number]["key"];
      target: DeployTarget;
      generation: string;
    }[],
  ): Promise<void>;
  operationId?: () => string;
  now?: () => number;
  schedule?: (task: () => void) => void;
};

export type DeployExecutionJournal = ((
  outcomes: readonly DeployOperationOutcome[],
) => Promise<void>) & {
  provisional(outcomes: readonly DeployOperationOutcome[]): Promise<void>;
  markLedgerPending(): void;
  markLedgerCommitted(): void;
  markFinalizing(): void;
};

export type DeployCoordinator = {
  accept(request: AcceptedDeployRequest): Promise<{ operationId: string }>;
  wait(operationId: string): Promise<void>;
};

function auditEvent(operationId: string, plan: DeployPlan): DeployAcceptedAudit {
  const perKindActionCounts: Record<string, number> = {};
  const targets = new Set<DeployTarget>();
  for (const action of plan.actions) {
    perKindActionCounts[action.key.kind] = (perKindActionCounts[action.key.kind] ?? 0) + 1;
    targets.add(action.target);
  }
  return {
    operationId,
    selectionRevision: plan.selectionRevision,
    perKindActionCounts,
    targetClis: [...targets].sort(),
  };
}

function outcomeId(value: Pick<DeployOperationOutcome, "key" | "target">): string {
  return `${serializeCapabilityKey(value.key)}\u0000${value.target}`;
}

function successfulRemovalIntents(operation: DeployOperation): Array<{
  key: DeployPlan["actions"][number]["key"];
  target: DeployTarget;
  generation: string;
}> {
  const completed: Array<{
    key: DeployPlan["actions"][number]["key"];
    target: DeployTarget;
    generation: string;
  }> = [];
  for (const outcome of operation.outcomes) {
    if (outcome.action !== "remove" || outcome.outcome !== "succeeded") continue;
    const accepted = operation.plan.actions.find(
      (action) => action.action === "remove" && outcomeId(action) === outcomeId(outcome),
    );
    if (!accepted?.removalIntentGeneration) continue;
    completed.push({
      key: outcome.key,
      target: outcome.target,
      generation: accepted.removalIntentGeneration,
    });
  }
  return completed.sort(
    (left, right) =>
      serializeCapabilityKey(left.key).localeCompare(serializeCapabilityKey(right.key)) ||
      left.target.localeCompare(right.target),
  );
}

export function createDeployCoordinator(
  options: CreateDeployCoordinatorOptions,
): DeployCoordinator {
  const operationId = options.operationId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((task: () => void) => setTimeout(task, 0));
  const running = new Map<string, Promise<void>>();
  const background = new Set<Promise<void>>();
  let recovery: Promise<void> | null = null;

  const journalFor = (id: string): DeployExecutionJournal =>
    Object.assign(
      async (outcomes: readonly DeployOperationOutcome[]): Promise<void> => {
        options.operations.recordOutcomes(id, outcomes);
      },
      {
        provisional: async (outcomes: readonly DeployOperationOutcome[]): Promise<void> => {
          options.operations.recordProvisionalOutcomes(id, outcomes);
        },
        markLedgerPending: (): void => {
          options.operations.markLedgerPending(id);
        },
        markLedgerCommitted: (): void => {
          options.operations.markLedgerCommitted(id);
        },
        markFinalizing: (): void => {
          options.operations.markFinalizing(id);
        },
      },
    );

  const finish = async (id: string): Promise<void> => {
    const completed = options.operations.read(id);
    if (!completed) throw new Error("operation_not_found");
    const expected = new Set(completed.plan.actions.map(outcomeId));
    const actual = new Set(completed.outcomes.map(outcomeId));
    const incomplete = [...expected].some((action) => !actual.has(action));
    const failed = completed.outcomes.some((outcome) => outcome.outcome === "failed");
    const removals = successfulRemovalIntents(completed);
    if (removals.length > 0) await options.clearRemovalIntents(removals);
    options.operations.finish(
      id,
      failed || incomplete ? "failed" : "completed",
      incomplete ? "incomplete" : undefined,
    );
  };

  const resumeRecoverable = async (): Promise<void> => {
    if (!options.resume) return;
    for (const operation of options.operations.recoverable()) {
      await options.resume(operation, journalFor(operation.operationId));
      await finish(operation.operationId);
    }
  };

  const recover = (): Promise<void> | null => {
    if (recovery) return recovery;
    if (!options.resume || options.operations.recoverable().length === 0) return null;
    const task = resumeRecoverable().finally(() => {
      if (recovery === task) recovery = null;
    });
    recovery = task;
    return task;
  };

  const execute = async (id: string): Promise<void> => {
    try {
      const runningOperation = options.operations.markRunning(id);
      await options.execute(runningOperation, journalFor(id));
      await finish(id);
    } catch (error) {
      log().warn(
        { module: "kit/deploy-coordinator", operationId: id, err: String(error) },
        "durable deploy execution failed",
      );
      try {
        options.operations.fail(id, "execution_failed");
      } catch (storeError) {
        log().warn(
          { module: "kit/deploy-coordinator", operationId: id, err: String(storeError) },
          "durable deploy failure state remains pending",
        );
        // A queued/running record remains restart-recoverable when storage is unavailable.
      }
    }
  };

  const start = (id: string): void => {
    let resolveDone = (): void => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    running.set(id, done);
    schedule(() => {
      const task = execute(id)
        .catch((error) => {
          log().warn(
            { module: "kit/deploy-coordinator", operationId: id, err: String(error) },
            "background deploy execution rejected",
          );
        })
        .finally(() => {
          resolveDone();
          running.delete(id);
          background.delete(task);
        });
      background.add(task);
    });
  };

  if (options.resume && options.operations.recoverable().length > 0) {
    schedule(() => {
      const pending = recover();
      if (!pending) return;
      const task = pending
        .catch((error) => {
          log().warn(
            { module: "kit/deploy-coordinator", err: String(error) },
            "durable deploy recovery remains pending",
          );
        })
        .finally(() => background.delete(task));
      background.add(task);
    });
  }

  return {
    accept: async (request) => {
      const pending = recover();
      if (pending) await pending;
      return options.mutationCoordinator.runExclusive(async () => {
        const active = options.operations.activeSummary();
        if (active) throw new DeployInProgressError(active.operationId);
        const captured = await options.capture();
        const currentToken = options.tokenForPlan(captured.plan);
        if (
          request.selectionRevision !== captured.plan.selectionRevision ||
          request.planToken !== currentToken
        ) {
          throw new PlanStaleError();
        }
        const staged = await options.stage(captured.snapshot, captured.plan);
        const recaptured = await options.capture();
        const recapturedToken = options.tokenForPlan(recaptured.plan);
        if (
          recaptured.plan.selectionRevision !== captured.plan.selectionRevision ||
          recapturedToken !== currentToken
        ) {
          throw new PlanStaleError();
        }
        const id = operationId();
        try {
          options.operations.createQueued({
            operationId: id,
            acceptedAt: now(),
            selectionRevision: captured.plan.selectionRevision,
            planToken: currentToken,
            plan: captured.plan,
            staged,
            auditState: "pending",
          });
        } catch (error) {
          if (error instanceof DeployOperationStoreError && error.code === "operation_active") {
            throw new DeployInProgressError(error.operationId ?? "active");
          }
          throw error;
        }
        try {
          await options.onAccepted(auditEvent(id, captured.plan));
          options.operations.markAuditRecorded(id);
        } catch (error) {
          try {
            options.operations.fail(id, "audit_failed");
          } catch {
            // Pending audit state is terminalized as audit_interrupted on restart.
          }
          throw error;
        }
        start(id);
        return { operationId: id };
      });
    },
    wait: async (id) => {
      const active = running.get(id);
      if (active) await active;
    },
  };
}

function currentMirrorIdentity(targets: DeployTargets, sourceId: string): string | null {
  try {
    return readMirrorIdentity(targets.mirrorRoot(sourceId));
  } catch {
    return null;
  }
}

function assertContentSha(
  targets: DeployTargets,
  sourceId: string,
  key: DeployPlan["actions"][number]["key"],
  expected: string,
): void {
  const current = mirrorContentSha(targets.mirrorRoot(sourceId), key.kind, key.name);
  if (current !== expected) throw new PlanStaleError();
}

function requiredActionSource(action: DeployPlan["actions"][number]): {
  sourceId: string;
  contentSha: string;
} {
  if (!action.sourceId || !action.contentSha) throw new PlanStaleError();
  return { sourceId: action.sourceId, contentSha: action.contentSha };
}

export function stageDeployPlan(
  targets: DeployTargets,
  snapshot: DeploymentSnapshot,
  plan: DeployPlan,
): StagedDeployPayload {
  for (const mirror of plan.mirrors) {
    if (currentMirrorIdentity(targets, mirror.sourceId) !== mirror.identity) {
      throw new PlanStaleError();
    }
  }
  const activeRoots = snapshot.sources
    .filter((source) => source.active)
    .map((source) => targets.mirrorRoot(source.id));
  const snippets = loadSnippets(activeRoots);
  const tasks: StagedDeployTask[] = [];

  for (const target of ["claude", "codex"] as const) {
    const actions = plan.actions.filter(
      (action) => action.key.kind === "instruction" && action.target === target,
    );
    if (actions.length === 0) continue;
    const write = plan.instructionWrites.find((candidate) => candidate.target === target);
    if (!write) {
      if (actions.some((action) => action.action !== "remove")) throw new PlanStaleError();
      tasks.push({
        type: "instruction",
        target,
        actions: actions.map(({ action, key }) => ({ action, key, target })),
        contributions: [],
        renderedHash: null,
        content: null,
      });
      continue;
    }
    const bodies: string[] = [];
    for (const contribution of write.contributions) {
      assertContentSha(targets, contribution.sourceId, contribution.key, contribution.contentSha);
      const body = instructionBody(
        targets.mirrorRoot(contribution.sourceId),
        contribution.key.name,
      );
      if (body === null) throw new PlanStaleError();
      bodies.push(body);
    }
    const content = transformInstructions(bodies);
    if (sha256(content) !== write.renderedHash) throw new PlanStaleError();
    tasks.push({
      type: "instruction",
      target,
      actions: actions.map(({ action, key }) => ({ action, key, target })),
      contributions: write.contributions,
      renderedHash: write.renderedHash,
      content,
    });
  }

  const kindOrder = ["skill", "agent", "plugin", "bundle"] as const;
  for (const kind of kindOrder) {
    for (const action of plan.actions.filter((candidate) => candidate.key.kind === kind)) {
      if (action.action === "remove") {
        if (action.key.kind !== "skill" && action.key.kind !== "agent") {
          throw new PlanStaleError();
        }
        tasks.push({
          type: "remove",
          action: "remove",
          key:
            action.key.kind === "skill"
              ? { kind: "skill", name: action.key.name }
              : { kind: "agent", name: action.key.name },
          target: action.target,
        });
        continue;
      }
      const { sourceId, contentSha } = requiredActionSource(action);
      assertContentSha(targets, sourceId, action.key, contentSha);
      if (action.key.kind === "skill") {
        const source = skillSourceDir(targets.mirrorRoot(sourceId), action.key.name);
        if (!source || !action.renderedHash) throw new PlanStaleError();
        const rendered = transformSkill(
          {
            name: action.key.name,
            files: readSkillSource(source),
            disableModelInvocation: skillDisablesModelInvocation(source),
          },
          snippets,
        );
        const files =
          rendered.sidecar && action.target === "codex"
            ? [...rendered.files, rendered.sidecar]
            : rendered.files;
        if (hashSkillFiles(files) !== action.renderedHash) throw new PlanStaleError();
        tasks.push({
          type: "skill",
          action: action.action,
          key: { kind: "skill", name: action.key.name },
          target: action.target,
          sourceId,
          contentSha,
          renderedHash: action.renderedHash,
          files,
        });
        continue;
      }
      if (action.key.kind === "agent") {
        const source = agentSourceDir(targets.mirrorRoot(sourceId), action.key.name);
        if (!source || !action.renderedHash) throw new PlanStaleError();
        const rendered = transformAgent(
          { name: action.key.name, raw: readFileSync(join(source, "AGENT.md"), "utf8") },
          snippets,
        );
        const content = action.target === "claude" ? rendered.claudeMd : rendered.codexToml;
        if (sha256(content) !== action.renderedHash) throw new PlanStaleError();
        tasks.push({
          type: "agent",
          action: action.action,
          key: { kind: "agent", name: action.key.name },
          target: action.target,
          sourceId,
          contentSha,
          renderedHash: action.renderedHash,
          content,
        });
        continue;
      }
      if (action.key.kind === "plugin") {
        const metadata = pluginMeta(targets.mirrorRoot(sourceId), action.key.name);
        if (!metadata || action.target !== "claude") throw new PlanStaleError();
        throw new ImmutableInstallerStagingError();
      }
      const metadata = bundleMeta(targets.mirrorRoot(sourceId), action.key.name);
      if (!metadata) throw new PlanStaleError();
      throw new ImmutableInstallerStagingError();
    }
  }
  return { tasks, metadata: {} };
}

export type ExecuteStagedDeployOptions = {
  fx: DeployFsExec;
  deploymentState: DeploymentStateStore;
  now?: () => number;
  ledgerWriteOptions?: LedgerWriteOptions;
};

export function markInterruptedDeploymentState(
  deploymentState: DeploymentStateStore,
  operation: DeployOperation,
): void {
  for (const action of operation.unfinishedActions ?? []) {
    deploymentState.markInterrupted(
      action.key,
      action.target,
      action.action,
      operation.operationId,
    );
  }
}

function taskActions(task: StagedDeployTask): Array<{
  action: "add" | "update" | "remove";
  key: DeployPlan["actions"][number]["key"];
  target: DeployTarget;
}> {
  if (task.type === "instruction") return task.actions;
  return [{ action: task.action, key: task.key, target: task.target }];
}

function applyStagedTask(fx: DeployFsExec, task: StagedDeployTask): void {
  switch (task.type) {
    case "instruction": {
      const path = deployedInstructionPath(fx.targets, task.target);
      if (task.content === null) {
        removeFile(path);
      } else {
        backupIfExists(path);
        writeFileAt(path, task.content);
      }
      return;
    }
    case "skill":
      writeSkillFolder(deployedSkillDir(fx.targets, task.key.name, task.target), task.files);
      return;
    case "agent":
      writeFileAt(deployedAgentPath(fx.targets, task.key.name, task.target), task.content);
      return;
    case "remove":
      if (task.key.kind === "skill") {
        removeDir(deployedSkillDir(fx.targets, task.key.name, task.target));
      } else {
        removeFile(deployedAgentPath(fx.targets, task.key.name, task.target));
      }
      return;
    case "plugin": {
      throw new ImmutableInstallerStagingError();
    }
    case "bundle": {
      throw new ImmutableInstallerStagingError();
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message === "missing_binary") return "missing_binary";
  if (error instanceof Error && error.message === "installer_failed") return "installer_failed";
  return "io";
}

export async function executeStagedDeploy(
  options: ExecuteStagedDeployOptions,
  operation: DeployOperation,
  journal:
    | DeployExecutionJournal
    | ((outcomes: readonly DeployOperationOutcome[]) => Promise<void>),
): Promise<void> {
  const now = options.now ?? Date.now;
  const provisional: DeployOperationOutcome[] = [];
  for (const task of operation.staged.tasks) {
    const actions = taskActions(task);
    let failureCode: string | undefined;
    try {
      applyStagedTask(options.fx, task);
    } catch (error) {
      failureCode = errorCode(error);
    }
    const outcomes = actions.map((action) => ({
      ...action,
      outcome: failureCode ? ("failed" as const) : ("succeeded" as const),
      attemptedAt: now(),
      ...(failureCode ? { code: failureCode } : {}),
    }));
    provisional.push(...outcomes);
    if ("provisional" in journal) await journal.provisional(outcomes);
  }

  const checkpointed = { ...operation, provisionalOutcomes: provisional };
  if ("markLedgerPending" in journal) journal.markLedgerPending();
  commitProvisionalLedger(options, checkpointed);
  if ("markLedgerCommitted" in journal) journal.markLedgerCommitted();
  if ("markFinalizing" in journal) journal.markFinalizing();
  finalizeCommittedDeployment(options, checkpointed);
  await journal(provisional);
}

function successfulTasks(operation: DeployOperation): StagedDeployTask[] {
  const successful = new Set(
    operation.provisionalOutcomes
      .filter((outcome) => outcome.outcome === "succeeded")
      .map(outcomeId),
  );
  return operation.staged.tasks.filter((task) =>
    taskActions(task).every((action) => successful.has(outcomeId(action))),
  );
}

function commitProvisionalLedger(
  options: ExecuteStagedDeployOptions,
  operation: DeployOperation,
): void {
  const succeededTasks = successfulTasks(operation);
  const importedOwnership = ledgerOwnershipByKey(readLedger(options.fx.targets));
  const successfulRemovalTargets = new Map<string, Set<DeployTarget>>();
  for (const outcome of operation.provisionalOutcomes) {
    if (outcome.outcome !== "succeeded" || outcome.action !== "remove") continue;
    const id = serializeCapabilityKey(outcome.key);
    const targets = successfulRemovalTargets.get(id) ?? new Set<DeployTarget>();
    targets.add(outcome.target);
    successfulRemovalTargets.set(id, targets);
  }

  const prunedSkills = new Set<string>();
  const prunedAgents = new Set<string>();
  const prunedInstructions = new Set<string>();
  for (const action of operation.plan.actions) {
    if (
      action.action !== "remove" ||
      !successfulRemovalTargets.get(serializeCapabilityKey(action.key))?.has(action.target)
    ) {
      continue;
    }
    const remainsApplied = (["claude", "codex"] as const).some((target) => {
      if (successfulRemovalTargets.get(serializeCapabilityKey(action.key))?.has(target)) {
        return false;
      }
      const record = options.deploymentState.read(action.key, target);
      return record
        ? record.applied !== undefined
        : (importedOwnership.get(serializeCapabilityKey(action.key))?.has(target) ?? false);
    });
    if (remainsApplied) continue;
    if (action.key.kind === "skill") prunedSkills.add(action.key.name);
    if (action.key.kind === "agent") prunedAgents.add(action.key.name);
    if (action.key.kind === "instruction") prunedInstructions.add(action.key.name);
  }
  const instructions = new Set<string>();
  const skills = new Set<string>();
  const agents = new Set<string>();
  const plugins = new Set<string>();
  const bundles = new Map<string, string | null>();
  const targets = new Set<DeployTarget>();
  for (const task of succeededTasks) {
    targets.add(task.target);
    if (task.type === "instruction" && task.content !== null) {
      for (const contribution of task.contributions) instructions.add(contribution.key.name);
    } else if (task.type === "skill") {
      skills.add(task.key.name);
    } else if (task.type === "agent") {
      agents.add(task.key.name);
    } else if (task.type === "plugin") {
      plugins.add(task.key.name);
    } else if (task.type === "bundle") {
      bundles.set(task.key.name, task.pin);
    }
  }
  mergeLedger(
    options.fx.targets,
    {
      kitVersion: "",
      targets: [...targets],
      skills: [...skills],
      agents: [...agents],
      instructions: [...instructions],
      plugins: [...plugins],
      bundles: [...bundles].map(([name, pin]) => ({ name, pin })),
    },
    [...prunedSkills],
    [...prunedAgents],
    [...prunedInstructions],
    options.ledgerWriteOptions,
  );
}

function finalizeCommittedDeployment(
  options: ExecuteStagedDeployOptions,
  operation: DeployOperation,
): void {
  const now = options.now ?? Date.now;
  const outcomes = new Map(
    operation.provisionalOutcomes.map((outcome) => [outcomeId(outcome), outcome]),
  );
  let firstError: unknown;
  for (const task of operation.staged.tasks) {
    const actions = taskActions(task);
    const succeeded = actions.every(
      (action) => outcomes.get(outcomeId(action))?.outcome === "succeeded",
    );
    try {
      if (!succeeded) {
        for (const action of actions) {
          const outcome = outcomes.get(outcomeId(action));
          options.deploymentState.recordFailure(
            action.key,
            action.target,
            {
              action: action.action,
              code: outcome?.code ?? "unknown",
              detail: "deploy action failed",
            },
            operation.operationId,
          );
        }
        continue;
      }
      if (task.type === "instruction") {
        for (const contribution of task.contributions) {
          options.deploymentState.recordSuccess(
            contribution.key,
            task.target,
            {
              sourceId: contribution.sourceId,
              contentSha: contribution.contentSha,
              renderedHash: task.renderedHash ?? "",
              appliedAt: now(),
            },
            operation.operationId,
          );
        }
        for (const action of task.actions.filter((candidate) => candidate.action === "remove")) {
          options.deploymentState.recordRemoval(action.key, action.target, operation.operationId);
        }
      } else if (task.type === "remove") {
        options.deploymentState.recordRemoval(task.key, task.target, operation.operationId);
      } else if (task.type === "plugin" || task.type === "bundle") {
        throw new ImmutableInstallerStagingError();
      } else {
        options.deploymentState.recordSuccess(
          task.key,
          task.target,
          {
            sourceId: task.sourceId,
            contentSha: task.contentSha,
            renderedHash: task.renderedHash,
            appliedAt: now(),
          },
          operation.operationId,
        );
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function resumeStagedDeploy(
  options: ExecuteStagedDeployOptions,
  operation: DeployOperation,
  journal: DeployExecutionJournal,
): Promise<void> {
  let phase = operation.executionPhase;
  if (phase === "ledger_pending") {
    commitProvisionalLedger(options, operation);
    journal.markLedgerCommitted();
    phase = "ledger_committed";
  }
  if (phase === "ledger_committed") {
    journal.markFinalizing();
    phase = "finalizing";
  }
  if (phase !== "finalizing") throw new Error("operation_not_recoverable");
  finalizeCommittedDeployment(options, operation);
  await journal(operation.provisionalOutcomes);
}
