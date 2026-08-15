import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeCapabilityKey } from "@hive/capability-schema";
import type { AcceptedDeployRequest, DeployTarget } from "@hive/contract";
import { mirrorContentSha } from "./content-sha.ts";
import {
  backupIfExists,
  type DeployFsExec,
  execInstaller,
  probeBinary,
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
import type { DeploymentSnapshot, DeployPlan } from "./deploy-plan.ts";
import type { DeploymentStateStore } from "./deployment-state.ts";
import { mergeLedger } from "./ledger.ts";
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
  execute(
    operation: DeployOperation,
    record: (outcomes: readonly DeployOperationOutcome[]) => Promise<void>,
  ): Promise<void>;
  onAccepted(event: DeployAcceptedAudit): Promise<void>;
  clearRemovalIntents(
    entries: readonly { key: DeployPlan["actions"][number]["key"]; targets: DeployTarget[] }[],
  ): Promise<void>;
  operationId?: () => string;
  now?: () => number;
  schedule?: (task: () => void) => void;
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

function successfulRemovalIntents(
  operation: DeployOperation,
): Array<{ key: DeployPlan["actions"][number]["key"]; targets: DeployTarget[] }> {
  const grouped = new Map<
    string,
    { key: DeployPlan["actions"][number]["key"]; targets: DeployTarget[] }
  >();
  for (const outcome of operation.outcomes) {
    if (outcome.action !== "remove" || outcome.outcome !== "succeeded") continue;
    const id = serializeCapabilityKey(outcome.key);
    const current = grouped.get(id) ?? { key: outcome.key, targets: [] };
    if (!current.targets.includes(outcome.target)) current.targets.push(outcome.target);
    grouped.set(id, current);
  }
  return [...grouped.values()].map((entry) => ({
    key: entry.key,
    targets: [...entry.targets].sort(),
  }));
}

export function createDeployCoordinator(
  options: CreateDeployCoordinatorOptions,
): DeployCoordinator {
  const operationId = options.operationId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((task: () => void) => queueMicrotask(task));
  const running = new Map<string, Promise<void>>();

  const execute = async (id: string): Promise<void> => {
    let runningOperation: DeployOperation | undefined;
    try {
      runningOperation = options.operations.markRunning(id);
      await options.execute(runningOperation, async (outcomes) => {
        options.operations.recordOutcomes(id, outcomes);
      });
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
    } catch {
      const current = options.operations.read(id);
      if (current?.state === "running") {
        const removals = successfulRemovalIntents(current);
        if (removals.length > 0) {
          try {
            await options.clearRemovalIntents(removals);
          } catch {
            // The operation remains failed; a later explicit Deploy can retry.
          }
        }
        options.operations.finish(id, "failed", "execution_failed");
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
      void execute(id).finally(() => {
        resolveDone();
        running.delete(id);
      });
    });
  };

  return {
    accept: (request) =>
      options.mutationCoordinator.runExclusive(async () => {
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
        const id = operationId();
        try {
          options.operations.createQueued({
            operationId: id,
            acceptedAt: now(),
            selectionRevision: captured.plan.selectionRevision,
            planToken: currentToken,
            plan: captured.plan,
            staged,
          });
        } catch (error) {
          if (error instanceof DeployOperationStoreError && error.code === "operation_active") {
            throw new DeployInProgressError(error.operationId ?? "active");
          }
          throw error;
        }
        start(id);
        await options.onAccepted(auditEvent(id, captured.plan));
        return { operationId: id };
      }),
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
        tasks.push({
          type: "plugin",
          action: action.action,
          key: { kind: "plugin", name: action.key.name },
          target: "claude",
          sourceId,
          contentSha,
          marketplaceSource: metadata.source,
          marketplaceName: metadata.market,
          pluginName: metadata.pluginName,
        });
        continue;
      }
      const metadata = bundleMeta(targets.mirrorRoot(sourceId), action.key.name);
      if (!metadata) throw new PlanStaleError();
      tasks.push({
        type: "bundle",
        action: action.action,
        key: { kind: "bundle", name: action.key.name },
        target: action.target,
        sourceId,
        contentSha,
        installerKind: metadata.installerKind,
        command: metadata.command,
        flags: metadata.flags,
        hostFlags: metadata.hostFlagMap[action.target] ?? [],
        package: metadata.pkg,
        pin:
          (metadata.installerKind === "npx-skills" ? metadata.pkg : metadata.pinnedCommit) || null,
      });
    }
  }
  return { tasks, metadata: {} };
}

export type ExecuteStagedDeployOptions = {
  fx: DeployFsExec;
  deploymentState: DeploymentStateStore;
  now?: () => number;
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

const skipPlugin = (): boolean => process.env.AGENT_KIT_SKIP_PLUGIN_INSTALL === "1";
const skipBundle = (): boolean => process.env.AGENT_KIT_SKIP_BUNDLE_INSTALL === "1";

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
      if (skipPlugin()) return;
      if (!probeBinary(fx, "claude")) throw new Error("missing_binary");
      const added = execInstaller(
        fx,
        {
          command: "claude",
          args: ["plugin", "marketplace", "add", task.marketplaceSource],
        },
        "claude",
      );
      if (added.status !== 0) throw new Error("installer_failed");
      const installed = execInstaller(
        fx,
        {
          command: "claude",
          args: [
            "plugin",
            "install",
            `${task.pluginName}@${task.marketplaceName}`,
            "--scope",
            "user",
          ],
        },
        "claude",
      );
      if (installed.status !== 0) throw new Error("installer_failed");
      return;
    }
    case "bundle": {
      if (skipBundle()) return;
      const tool = task.installerKind === "npx-skills" ? "npx" : "git";
      if (!probeBinary(fx, tool)) throw new Error("missing_binary");
      const request =
        task.installerKind === "npx-skills"
          ? {
              command: "npx",
              args: [
                "-y",
                "skills",
                "add",
                task.package,
                "--global",
                "--agent",
                task.target === "claude" ? "claude-code" : "codex",
                "--skill",
                "*",
                "--yes",
              ],
            }
          : {
              command: "bash",
              args: [task.command, ...task.flags, ...task.hostFlags],
            };
      const result = execInstaller(fx, request, tool);
      if (result.status !== 0) throw new Error("installer_failed");
      return;
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
  record: (outcomes: readonly DeployOperationOutcome[]) => Promise<void>,
): Promise<void> {
  const now = options.now ?? Date.now;
  const succeededTasks: StagedDeployTask[] = [];
  for (const task of operation.staged.tasks) {
    const actions = taskActions(task);
    let failureCode: string | undefined;
    try {
      applyStagedTask(options.fx, task);
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
      } else {
        options.deploymentState.recordSuccess(
          task.key,
          task.target,
          {
            sourceId: task.sourceId,
            contentSha: task.contentSha,
            renderedHash:
              task.type === "skill" || task.type === "agent" ? task.renderedHash : task.contentSha,
            appliedAt: now(),
          },
          operation.operationId,
        );
      }
      succeededTasks.push(task);
    } catch (error) {
      failureCode = errorCode(error);
      for (const action of actions) {
        try {
          options.deploymentState.recordFailure(
            action.key,
            action.target,
            { action: action.action, code: failureCode, detail: "deploy action failed" },
            operation.operationId,
          );
        } catch {
          // The durable operation outcome remains the fallback checkpoint.
        }
      }
    }
    await record(
      actions.map((action) => ({
        ...action,
        outcome: failureCode ? ("failed" as const) : ("succeeded" as const),
        attemptedAt: now(),
        ...(failureCode ? { code: failureCode } : {}),
      })),
    );
  }

  const successful = new Set(succeededTasks.flatMap((task) => taskActions(task).map(outcomeId)));
  const prunedSkills = new Set<string>();
  const prunedAgents = new Set<string>();
  const prunedInstructions = new Set<string>();
  for (const action of operation.plan.actions) {
    if (action.action !== "remove" || !successful.has(outcomeId(action))) continue;
    if (options.deploymentState.read(action.key, action.target)?.applied) continue;
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
  );
}
