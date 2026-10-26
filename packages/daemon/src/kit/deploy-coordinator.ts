import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeCapabilityKey } from "@hive/capability-schema";
import type { AcceptedDeployRequest, DeployTarget } from "@hive/contract";
import { withCooperativeFileLockAsync } from "../lib/durable-file.ts";
import { log } from "../lib/log.ts";
import { mirrorContentSha } from "./content-sha.ts";
import {
  backupIfExists,
  type DeployFsExec,
  ensureDir,
  execInstaller,
  probeBinary,
  removeDir,
  removeFile,
  writeFileAt,
  writeSkillFolder,
} from "./deploy/adapter.ts";
import {
  deployedAgentPath,
  deployedInstructionPath,
  deployedSkillDir,
  hashDeployedAgent,
  hashDeployedInstruction,
  hashDeployedSkill,
  hashSkillFiles,
  sha256,
} from "./deploy/artifact-hash.ts";
import { boundedInstallerDetail, InstallerTaskError } from "./deploy/installer-error.ts";
import {
  marketplacePluginCommands,
  marketplacePluginInstalled,
  marketplacePluginRemoveCommand,
} from "./deploy/marketplace-plugin.ts";
import {
  immutableNpxBundleSource,
  managedNpxBundleHash,
  managedNpxBundleMeta,
  probeManagedNpxBundle,
} from "./deploy/npx-bundle.ts";
import {
  agentSourceDir,
  bundleMeta,
  instructionBody,
  loadSnippets,
  pluginMeta,
  renderedSkillFiles,
} from "./deploy/sources.ts";
import {
  applyTileBundle,
  checkoutLocation,
  hiveCheckout,
  installedTargets,
  repoRecipeOf,
  resolveTileBundle,
  tileTaskSettled,
} from "./deploy/tile-bundle.ts";
import { transformAgent, transformInstructions } from "./deploy/transforms.ts";
import {
  type DeployOperation,
  type DeployOperationOutcome,
  type DeployOperationStore,
  DeployOperationStoreError,
  type StagedDeployPayload,
  type StagedDeployTask,
  stagedFile,
  stagedSkillFile,
} from "./deploy-operations.ts";
import { type DeploymentSnapshot, type DeployPlan, ledgerOwnershipByKey } from "./deploy-plan.ts";
import type { DeploymentStateStore } from "./deployment-state.ts";
import {
  type LedgerWriteOptions,
  mergeLedger,
  mergeLedgerWithinLock,
  readLedger,
} from "./ledger.ts";
import { readMirrorIdentity } from "./mirror.ts";
import { tileById } from "./recipes/tiles.ts";
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
    if (readMirrorIdentity(targets.mirrorRoot(mirror.sourceId)) !== mirror.identity) {
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

  const tileTasks: TileBundleTask[] = [];
  const kindOrder = ["skill", "agent", "plugin", "bundle"] as const;
  for (const kind of kindOrder) {
    for (const action of plan.actions.filter((candidate) => candidate.key.kind === kind)) {
      if (action.key.kind === "bundle") {
        const tileTask = stageTileBundle(targets, snapshot, plan, action);
        if (tileTask) {
          tileTasks.push(tileTask);
          continue;
        }
      }
      if (
        action.action === "remove" &&
        (action.key.kind === "skill" || action.key.kind === "agent")
      ) {
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
      if (action.action === "remove" && action.key.kind === "plugin") {
        tasks.push(stagePluginRemoval(targets, snapshot, action));
        continue;
      }
      if (action.action === "remove" && action.key.kind === "bundle") {
        tasks.push(stageNpxBundleRemoval(targets, snapshot, plan, action));
        continue;
      }
      if (action.action === "remove") throw new PlanStaleError();
      const { sourceId, contentSha } = requiredActionSource(action);
      assertContentSha(targets, sourceId, action.key, contentSha);
      if (action.key.kind === "skill") {
        if (!action.renderedHash) throw new PlanStaleError();
        const files = renderedSkillFiles(
          targets.mirrorRoot(sourceId),
          action.key.name,
          action.target,
          snippets,
        );
        if (!files || hashSkillFiles(files) !== action.renderedHash) throw new PlanStaleError();
        tasks.push({
          type: "skill",
          action: action.action,
          key: { kind: "skill", name: action.key.name },
          target: action.target,
          sourceId,
          contentSha,
          renderedHash: action.renderedHash,
          files: files.map(stagedFile),
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
        if (!metadata?.targets.includes(action.target) || !metadata.source || !metadata.market) {
          throw new PlanStaleError();
        }
        tasks.push({
          type: "marketplace-plugin",
          action: action.action,
          key: { kind: "plugin", name: action.key.name },
          target: action.target,
          marketplaceSource: metadata.source,
          marketplaceName: metadata.market,
          pluginName: metadata.pluginName,
          sourceId,
          contentSha,
        });
        continue;
      }
      const managed = pointerNpxBundle(targets, action, sourceId);
      tasks.push({
        type: "npx-bundle",
        action: action.action,
        key: { kind: "bundle", name: action.key.name },
        target: action.target,
        package: managed.package,
        skills: managed.skills,
        verifyPaths: managed.verifyPaths,
        pin: managed.package,
        sourceId,
        contentSha,
        renderedHash: managedNpxBundleHash(managed, action.target),
        keep: [],
      });
    }
  }
  tasks.push(...orderTileTasks(targets, snapshot, tileTasks));
  return { tasks, metadata: {} };
}

type PlanAction = DeployPlan["actions"][number];

function appliedRecord(snapshot: DeploymentSnapshot, key: PlanAction["key"], target: DeployTarget) {
  return snapshot.deploymentState.records.find(
    (record) =>
      record.target === target &&
      serializeCapabilityKey(record.key) === serializeCapabilityKey(key),
  )?.applied;
}

type TileBundleTask = Extract<StagedDeployTask, { type: "tile-bundle" }>;

const sameKey = (left: PlanAction["key"], right: PlanAction["key"]) =>
  serializeCapabilityKey(left) === serializeCapabilityKey(right);

function selectedTargets(snapshot: DeploymentSnapshot, key: PlanAction["key"]): DeployTarget[] {
  return snapshot.selection.enabled.find((entry) => sameKey(entry.key, key))?.targets ?? [];
}

// A Tile installer pointer in the Mirror of `sourceId`, with that Source's Tile.
function tilePointer(
  targets: DeployTargets,
  snapshot: DeploymentSnapshot,
  sourceId: string | undefined,
  name: string,
) {
  if (!sourceId) return null;
  const meta = bundleMeta(targets.mirrorRoot(sourceId), name);
  if (meta?.installerKind !== "tile") return null;
  return { meta, tile: tileById(snapshot.sourceTiles.get(sourceId) ?? "") };
}

// Null when the action's bundle is not a Tile installer. A removal reads Hive's
// install record first, so it still runs after the Source is gone.
function stageTileBundle(
  targets: DeployTargets,
  snapshot: DeploymentSnapshot,
  plan: DeployPlan,
  action: PlanAction,
): TileBundleTask | null {
  const key = { kind: "bundle" as const, name: action.key.name };
  const selected = selectedTargets(snapshot, action.key);
  if (action.action !== "remove") {
    const { sourceId, contentSha } = requiredActionSource(action);
    const pointer = tilePointer(targets, snapshot, sourceId, key.name);
    if (!pointer) return null;
    assertContentSha(targets, sourceId, action.key, contentSha);
    const resolved = resolveTileBundle(
      pointer.meta,
      pointer.tile,
      action.target,
      selected,
      targets,
    );
    if (!resolved || resolved.renderedHash !== action.renderedHash) throw new PlanStaleError();
    return {
      type: "tile-bundle",
      action: action.action,
      key,
      target: action.target,
      tile: resolved.tile.id,
      checkout: resolved.checkout,
      commit: resolved.commit,
      sourceId,
      contentSha,
      renderedHash: resolved.renderedHash,
      keep: [],
      release: null,
    };
  }

  const record = appliedRecord(snapshot, action.key, action.target);
  const via = record?.installedVia?.installer === "tile" ? record.installedVia : null;
  const pointer = tilePointer(targets, snapshot, action.sourceId, key.name);
  if (pointer && action.sourceId && action.contentSha) {
    assertContentSha(targets, action.sourceId, action.key, action.contentSha);
  }
  const resolved = pointer
    ? resolveTileBundle(
        pointer.meta,
        pointer.tile,
        action.target,
        [...selected, action.target],
        targets,
      )
    : null;
  const tileId = via?.tile ?? resolved?.tile.id;
  const commit = via?.commit ?? resolved?.commit;
  if (!tileId || !commit) return null;

  const tile = tileById(tileId);
  const recipe = repoRecipeOf(tile);
  const keep: TileBundleTask["keep"] = [];
  if (tile && recipe?.installer.targets[action.target]?.uninstall.scope === "all-targets") {
    const desired = installedTargets(recipe, selected);
    const checkout = checkoutLocation(tile, recipe, desired, targets);
    for (const other of desired) {
      if (other === action.target) continue;
      if (
        plan.actions.some(
          (candidate) => candidate.target === other && sameKey(candidate.key, action.key),
        )
      ) {
        continue;
      }
      const kept = appliedRecord(snapshot, action.key, other);
      if (!kept) continue;
      const keptVia = kept.installedVia?.installer === "tile" ? kept.installedVia : null;
      const keptCommit = resolved?.commit ?? keptVia?.commit;
      if (keptCommit) keep.push({ target: other, checkout, commit: keptCommit });
    }
  }
  return {
    type: "tile-bundle",
    action: "remove",
    key,
    target: action.target,
    tile: tileId,
    checkout: via ? via.checkout : (resolved?.checkout ?? null),
    commit,
    sourceId: action.sourceId ?? null,
    contentSha: action.contentSha ?? null,
    renderedHash: action.renderedHash ?? record?.renderedHash ?? "",
    keep,
    release: null,
  };
}

// An all-targets uninstall also removes what an earlier install task in the
// same Deploy put down, so each bundle's removals run first. The last task of
// a bundle releases its Hive-owned checkout when no desired target uses it.
function orderTileTasks(
  targets: DeployTargets,
  snapshot: DeploymentSnapshot,
  staged: readonly TileBundleTask[],
): TileBundleTask[] {
  const ordered = [
    ...staged.filter((task) => task.action === "remove"),
    ...staged.filter((task) => task.action !== "remove"),
  ];
  const last = new Map<string, number>();
  ordered.forEach((task, index) => {
    last.set(serializeCapabilityKey(task.key), index);
  });
  return ordered.map((task, index) => {
    if (last.get(serializeCapabilityKey(task.key)) !== index) return task;
    const tile = tileById(task.tile);
    const recipe = repoRecipeOf(tile);
    if (!tile || !recipe?.installer.checkout) return task;
    const desired = installedTargets(recipe, selectedTargets(snapshot, task.key));
    const inUse = desired.length > 0 ? checkoutLocation(tile, recipe, desired, targets) : null;
    const owned = hiveCheckout(targets, tile.id);
    return inUse === owned ? task : { ...task, release: owned };
  });
}

// The managed npx installer a bundle pointer renders for one target; the plan's
// rendered hash binds the pointer read at acceptance.
function pointerNpxBundle(targets: DeployTargets, action: PlanAction, sourceId: string) {
  const metadata = bundleMeta(targets.mirrorRoot(sourceId), action.key.name);
  if (!metadata) throw new PlanStaleError();
  const managed = managedNpxBundleMeta(metadata, action.target, targets);
  if (!managed || managedNpxBundleHash(managed, action.target) !== action.renderedHash) {
    throw new ImmutableInstallerStagingError();
  }
  return managed;
}

// Hive's install record names what to uninstall. Without one, as for a plugin the
// Ledger records but Hive never installed, the current pointer does.
function stagePluginRemoval(
  targets: DeployTargets,
  snapshot: DeploymentSnapshot,
  action: PlanAction,
): StagedDeployTask {
  const key = { kind: "plugin" as const, name: action.key.name };
  const recorded = appliedRecord(snapshot, action.key, action.target)?.installedVia;
  if (recorded?.installer === "marketplace-plugin") {
    return {
      type: "marketplace-plugin-remove",
      action: "remove",
      key,
      target: action.target,
      marketplaceName: recorded.marketplaceName,
      pluginName: recorded.pluginName,
    };
  }
  const { sourceId, contentSha } = requiredActionSource(action);
  assertContentSha(targets, sourceId, action.key, contentSha);
  const metadata = pluginMeta(targets.mirrorRoot(sourceId), action.key.name);
  if (!metadata?.market) throw new PlanStaleError();
  return {
    type: "marketplace-plugin-remove",
    action: "remove",
    key,
    target: action.target,
    marketplaceName: metadata.market,
    pluginName: metadata.pluginName,
  };
}

function stageNpxBundleRemoval(
  targets: DeployTargets,
  snapshot: DeploymentSnapshot,
  plan: DeployPlan,
  action: PlanAction,
): StagedDeployTask {
  type Install = Omit<NpxBundleInstall, "target">;
  const recordedInstall = (target: DeployTarget): Install | null => {
    const recorded = appliedRecord(snapshot, action.key, target)?.installedVia;
    return recorded?.installer === "npx-skills" ? recorded : null;
  };
  const pointerInstall = (target: DeployTarget): Install | null => {
    if (!action.sourceId || !action.contentSha) return null;
    assertContentSha(targets, action.sourceId, action.key, action.contentSha);
    const metadata = bundleMeta(targets.mirrorRoot(action.sourceId), action.key.name);
    return metadata ? managedNpxBundleMeta(metadata, target, targets) : null;
  };

  const removed =
    recordedInstall(action.target) ??
    (action.sourceId ? pointerNpxBundle(targets, action, action.sourceId) : null);
  if (!removed) throw new PlanStaleError();
  const keep: NpxBundleInstall[] = [];
  for (const target of ["claude", "codex"] as const) {
    if (target === action.target) continue;
    const other = plan.actions.find(
      (candidate) =>
        candidate.target === target &&
        serializeCapabilityKey(candidate.key) === serializeCapabilityKey(action.key),
    );
    if (other?.action === "remove") continue;
    let kept: Install | null = null;
    if (other) {
      if (!other.sourceId) throw new PlanStaleError();
      kept = pointerNpxBundle(targets, other, other.sourceId);
    } else if (appliedRecord(snapshot, action.key, target)) {
      kept = recordedInstall(target) ?? pointerInstall(target);
    }
    if (kept) {
      keep.push({
        target,
        package: kept.package,
        skills: kept.skills,
        verifyPaths: kept.verifyPaths,
      });
    }
  }
  return {
    type: "npx-bundle",
    action: "remove",
    key: { kind: "bundle", name: action.key.name },
    target: action.target,
    package: removed.package,
    skills: removed.skills,
    verifyPaths: removed.verifyPaths,
    pin: removed.package,
    sourceId: action.sourceId ?? null,
    contentSha: action.contentSha ?? null,
    renderedHash:
      action.renderedHash ?? appliedRecord(snapshot, action.key, action.target)?.renderedHash ?? "",
    keep,
  };
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

type NpxBundleTask = Extract<StagedDeployTask, { type: "npx-bundle" }>;
type NpxBundleInstall = NpxBundleTask["keep"][number];

function npxBundleSettled(task: NpxBundleTask): boolean {
  const expected = task.action === "remove" ? "all-absent" : "all-present";
  return (
    probeManagedNpxBundle(task) === expected &&
    task.keep.every((kept) => probeManagedNpxBundle(kept) === "all-present")
  );
}

function prepareImmutableNpxBundleSource(
  fx: DeployFsExec,
  bundleName: string,
  packageRef: string,
): string {
  const source = immutableNpxBundleSource(packageRef);
  if (!source) throw new InstallerTaskError("installer_failed", "invalid immutable package");
  if (!probeBinary(fx, "git")) {
    throw new InstallerTaskError("missing_binary", "git is not available on PATH");
  }

  const checkout = join(fx.targets.kitTmpRoot(), "npx-skills", bundleName, source.commit);
  const installRoot = source.subpath ? join(checkout, ...source.subpath.split("/")) : checkout;
  if (existsSync(checkout)) {
    const head = execInstaller(
      fx,
      { command: "git", args: ["-C", checkout, "rev-parse", "HEAD"] },
      "git",
    );
    if (head.status === 0 && head.stdout.trim().toLowerCase() === source.commit) {
      if (!existsSync(installRoot)) {
        throw new InstallerTaskError("installer_failed", "immutable package subpath is missing");
      }
      return installRoot;
    }
    removeDir(checkout);
  }

  ensureDir(checkout);
  const commands = [
    ["init", checkout],
    ["-C", checkout, "remote", "add", "origin", source.source],
    ["-C", checkout, "fetch", "--depth", "1", "origin", source.commit],
    ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"],
  ];
  for (const args of commands) {
    const result = execInstaller(fx, { command: "git", args }, "git");
    if (result.status !== 0) {
      removeDir(checkout);
      throw new InstallerTaskError(
        "installer_failed",
        boundedInstallerDetail(
          [result.stdout, result.stderr].filter(Boolean).join("\n") ||
            `git exited ${result.status}`,
        ),
      );
    }
  }

  const head = execInstaller(
    fx,
    { command: "git", args: ["-C", checkout, "rev-parse", "HEAD"] },
    "git",
  );
  if (head.status !== 0 || head.stdout.trim().toLowerCase() !== source.commit) {
    removeDir(checkout);
    throw new InstallerTaskError("installer_failed", "immutable package checkout mismatch");
  }
  if (!existsSync(installRoot)) {
    removeDir(checkout);
    throw new InstallerTaskError("installer_failed", "immutable package subpath is missing");
  }
  return installRoot;
}

function runNpx(fx: DeployFsExec, args: string[], cwd: string | undefined): void {
  const result = execInstaller(fx, { command: "npx", args, cwd }, "npx");
  if (result.status !== 0) {
    throw new InstallerTaskError(
      "installer_failed",
      boundedInstallerDetail(
        [result.stdout, result.stderr].filter(Boolean).join("\n") || `npx exited ${result.status}`,
      ),
    );
  }
}

// Claude gets its own copy: the CLI's default links Claude to the shared
// `~/.agents/skills` folder, which would expose the skill to Codex as well.
function installNpxBundle(fx: DeployFsExec, bundleName: string, install: NpxBundleInstall): void {
  const installRoot = prepareImmutableNpxBundleSource(fx, bundleName, install.package);
  const agent = install.target === "claude" ? ["claude-code", "--copy"] : ["codex"];
  runNpx(
    fx,
    [
      "-y",
      "skills",
      "add",
      ".",
      "--global",
      "--agent",
      ...agent,
      ...install.skills.flatMap((skill) => ["--skill", skill]),
      "--yes",
    ],
    installRoot,
  );
}

function applyManagedNpxBundle(fx: DeployFsExec, task: NpxBundleTask): void {
  if (npxBundleSettled(task)) return;
  if (!probeBinary(fx, "npx")) {
    throw new InstallerTaskError("missing_binary", "npx is not available on PATH");
  }
  if (task.action === "remove") {
    // The skills CLI keeps a shared skill while any other agent still has it, so
    // only the full uninstall a user would run removes it from one target.
    runNpx(fx, ["-y", "skills", "remove", ...task.skills, "--global", "--yes"], undefined);
    for (const kept of task.keep) installNpxBundle(fx, task.key.name, kept);
  } else {
    installNpxBundle(fx, task.key.name, task);
  }
  if (!npxBundleSettled(task)) {
    throw new InstallerTaskError(
      "installer_failed",
      `npx completed without satisfying ${task.action} postcondition`,
    );
  }
}

function applyMarketplacePlugin(
  fx: DeployFsExec,
  task: Extract<StagedDeployTask, { type: "marketplace-plugin" }>,
): void {
  if (!probeBinary(fx, task.target)) {
    throw new InstallerTaskError("missing_binary", `${task.target} is not available on PATH`);
  }
  for (const request of marketplacePluginCommands(task)) {
    const result = execInstaller(fx, request, request.command);
    if (result.status !== 0) {
      throw new InstallerTaskError(
        "installer_failed",
        boundedInstallerDetail(
          [result.stdout, result.stderr].filter(Boolean).join("\n") ||
            `${request.command} exited ${result.status}`,
        ),
      );
    }
  }
  if (!marketplacePluginInstalled(fx.targets, task)) {
    throw new InstallerTaskError(
      "installer_failed",
      `${task.target} completed without recording ${task.pluginName}@${task.marketplaceName}`,
    );
  }
}

function removeMarketplacePlugin(
  fx: DeployFsExec,
  task: Extract<StagedDeployTask, { type: "marketplace-plugin-remove" }>,
): void {
  if (!marketplacePluginInstalled(fx.targets, task)) return;
  if (!probeBinary(fx, task.target)) {
    throw new InstallerTaskError("missing_binary", `${task.target} is not available on PATH`);
  }
  const request = marketplacePluginRemoveCommand(task);
  const result = execInstaller(fx, request, request.command);
  if (result.status !== 0) {
    throw new InstallerTaskError(
      "installer_failed",
      boundedInstallerDetail(
        [result.stdout, result.stderr].filter(Boolean).join("\n") ||
          `${request.command} exited ${result.status}`,
      ),
    );
  }
  if (marketplacePluginInstalled(fx.targets, task)) {
    throw new InstallerTaskError(
      "installer_failed",
      `${task.target} still records ${task.pluginName}@${task.marketplaceName}`,
    );
  }
}

function applyStagedTask(fx: DeployFsExec, task: StagedDeployTask): void {
  switch (task.type) {
    case "instruction": {
      const path = deployedInstructionPath(fx.targets, task.target);
      if (task.content === null) {
        backupIfExists(path);
        removeFile(path);
      } else {
        backupIfExists(path);
        writeFileAt(path, task.content);
      }
      return;
    }
    case "skill":
      writeSkillFolder(
        deployedSkillDir(fx.targets, task.key.name, task.target),
        task.files.map(stagedSkillFile),
      );
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
    case "npx-bundle":
      applyManagedNpxBundle(fx, task);
      return;
    case "tile-bundle":
      applyTileBundle(fx, task);
      return;
    case "marketplace-plugin":
      applyMarketplacePlugin(fx, task);
      return;
    case "marketplace-plugin-remove":
      removeMarketplacePlugin(fx, task);
      return;
  }
}

function failureFor(error: unknown): { code: string; detail?: string } {
  if (error instanceof InstallerTaskError) {
    return { code: error.code, ...(error.detail ? { detail: error.detail } : {}) };
  }
  return { code: "io" };
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
  const lockOptions = options.ledgerWriteOptions ?? {};
  await withCooperativeFileLockAsync(
    options.fx.targets.ledgerPath(),
    lockOptions.lockTimeoutMs ?? 5_000,
    async () => {
      for (const task of operation.staged.tasks) {
        const actions = taskActions(task);
        let failure: { code: string; detail?: string } | undefined;
        try {
          applyStagedTask(options.fx, task);
        } catch (error) {
          failure = failureFor(error);
        }
        const outcomes = actions.map((action) => ({
          ...action,
          outcome: failure ? ("failed" as const) : ("succeeded" as const),
          attemptedAt: now(),
          ...(failure ? failure : {}),
        }));
        provisional.push(...outcomes);
        if ("provisional" in journal) await journal.provisional(outcomes);
      }

      const checkpointed = { ...operation, provisionalOutcomes: provisional };
      if ("markLedgerPending" in journal) journal.markLedgerPending();
      commitProvisionalLedger(options, checkpointed, true);
      if ("markLedgerCommitted" in journal) journal.markLedgerCommitted();
    },
    { staleMs: lockOptions.lockStaleMs, updateMs: lockOptions.lockUpdateMs },
  );
  const checkpointed = { ...operation, provisionalOutcomes: provisional };
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

function stagedTaskStillApplied(fx: DeployFsExec, task: StagedDeployTask): boolean {
  try {
    switch (task.type) {
      case "instruction":
        return hashDeployedInstruction(fx.targets, task.target) === task.renderedHash;
      case "skill":
        return hashDeployedSkill(fx.targets, task.key.name, task.target) === task.renderedHash;
      case "agent":
        return hashDeployedAgent(fx.targets, task.key.name, task.target) === task.renderedHash;
      case "remove":
        return task.key.kind === "skill"
          ? hashDeployedSkill(fx.targets, task.key.name, task.target) === null
          : hashDeployedAgent(fx.targets, task.key.name, task.target) === null;
      case "npx-bundle":
        return npxBundleSettled(task);
      case "tile-bundle":
        return tileTaskSettled(fx, task);
      case "marketplace-plugin":
        return marketplacePluginInstalled(fx.targets, task);
      case "marketplace-plugin-remove":
        return !marketplacePluginInstalled(fx.targets, task);
    }
  } catch {
    return false;
  }
}

function revalidateRecoveryOutcomes(
  fx: DeployFsExec,
  operation: DeployOperation,
): DeployOperationOutcome[] {
  const changed = new Set<string>();
  for (const task of operation.staged.tasks) {
    if (stagedTaskStillApplied(fx, task)) continue;
    for (const action of taskActions(task)) changed.add(outcomeId(action));
  }
  return operation.provisionalOutcomes.map((outcome) =>
    outcome.outcome === "succeeded" && changed.has(outcomeId(outcome))
      ? {
          ...outcome,
          outcome: "failed" as const,
          code: "recovery_state_changed",
          detail: "deployed artifact changed before Ledger recovery",
        }
      : outcome,
  );
}

function commitProvisionalLedger(
  options: ExecuteStagedDeployOptions,
  operation: DeployOperation,
  ledgerLocked = false,
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
  const prunedPlugins = new Set<string>();
  const prunedBundles = new Set<string>();
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
      if (record?.applied !== undefined) return true;
      if (record?.lastAttempt.action === "remove" && record.lastAttempt.outcome === "succeeded") {
        return false;
      }
      return importedOwnership.get(serializeCapabilityKey(action.key))?.has(target) ?? false;
    });
    if (remainsApplied) continue;
    if (action.key.kind === "skill") prunedSkills.add(action.key.name);
    if (action.key.kind === "agent") prunedAgents.add(action.key.name);
    if (action.key.kind === "instruction") prunedInstructions.add(action.key.name);
    if (action.key.kind === "plugin") prunedPlugins.add(action.key.name);
    if (action.key.kind === "bundle") prunedBundles.add(action.key.name);
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
    } else if (task.type === "marketplace-plugin") {
      plugins.add(task.key.name);
    } else if (task.type === "npx-bundle" && task.action !== "remove") {
      bundles.set(task.key.name, task.pin);
    }
  }
  const commit = ledgerLocked ? mergeLedgerWithinLock : mergeLedger;
  commit(
    options.fx.targets,
    {
      kitVersion: "",
      targets: [...targets],
      skills: [...skills],
      agents: [...agents],
      instructions: [...instructions],
      plugins: [...plugins],
      bundles: [...bundles].map(([name, pin]) => ({ name, pin })),
      prunedPlugins: [...prunedPlugins],
      prunedBundles: [...prunedBundles],
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
              detail: outcome?.detail ?? "deploy action failed",
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
      } else if (task.type === "npx-bundle") {
        if (task.action === "remove") {
          options.deploymentState.recordRemoval(task.key, task.target, operation.operationId);
        } else {
          options.deploymentState.recordSuccess(
            task.key,
            task.target,
            {
              sourceId: task.sourceId,
              contentSha: task.contentSha,
              renderedHash: task.renderedHash,
              appliedAt: now(),
              installedVia: {
                installer: "npx-skills",
                package: task.package,
                skills: task.skills,
                verifyPaths: task.verifyPaths,
              },
            },
            operation.operationId,
          );
        }
      } else if (task.type === "tile-bundle") {
        if (task.action === "remove") {
          options.deploymentState.recordRemoval(task.key, task.target, operation.operationId);
        } else {
          options.deploymentState.recordSuccess(
            task.key,
            task.target,
            {
              sourceId: task.sourceId,
              contentSha: task.contentSha,
              renderedHash: task.renderedHash,
              appliedAt: now(),
              installedVia: {
                installer: "tile",
                tile: task.tile,
                checkout: task.checkout,
                commit: task.commit,
              },
            },
            operation.operationId,
          );
        }
      } else if (task.type === "marketplace-plugin") {
        options.deploymentState.recordSuccess(
          task.key,
          task.target,
          {
            sourceId: task.sourceId,
            contentSha: task.contentSha,
            renderedHash: task.contentSha,
            appliedAt: now(),
            installedVia: {
              installer: "marketplace-plugin",
              marketplaceName: task.marketplaceName,
              pluginName: task.pluginName,
            },
          },
          operation.operationId,
        );
      } else if (task.type === "marketplace-plugin-remove") {
        options.deploymentState.recordRemoval(task.key, task.target, operation.operationId);
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
  let recovered = operation;
  if (phase === "applying") {
    await executeStagedDeploy(options, operation, journal);
    return;
  }
  if (phase === "ledger_pending") {
    const lockOptions = options.ledgerWriteOptions ?? {};
    await withCooperativeFileLockAsync(
      options.fx.targets.ledgerPath(),
      lockOptions.lockTimeoutMs ?? 5_000,
      async () => {
        recovered = {
          ...operation,
          provisionalOutcomes: revalidateRecoveryOutcomes(options.fx, operation),
        };
        commitProvisionalLedger(options, recovered, true);
        journal.markLedgerCommitted();
      },
      { staleMs: lockOptions.lockStaleMs, updateMs: lockOptions.lockUpdateMs },
    );
    phase = "ledger_committed";
  }
  if (phase === "ledger_committed") {
    journal.markFinalizing();
    phase = "finalizing";
  }
  if (phase !== "finalizing") throw new Error("operation_not_recoverable");
  if (operation.finalizationState !== "already_recorded") {
    finalizeCommittedDeployment(options, recovered);
  }
  await journal(recovered.provisionalOutcomes);
}
