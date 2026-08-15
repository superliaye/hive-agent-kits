import { createHash } from "node:crypto";
import { type CapabilityKey, serializeCapabilityKey } from "@hive/capability-schema";
import type {
  Catalog,
  DeployOperationSummary,
  DeployTarget,
  Ledger,
  OverviewMirror,
  OverviewSource,
  SelectionSnapshot,
} from "@hive/contract";
import type { DeploymentStateFile } from "./deployment-state.ts";

export type ArtifactObservation = {
  key: CapabilityKey;
  target: DeployTarget;
  existence: "present" | "missing" | "error";
  hash: string | null;
  error?: "read";
};

export type WouldDeployArtifact = {
  key: CapabilityKey;
  target: DeployTarget;
  sourceId: string;
  contentSha: string;
  renderedHash: string | null;
  error?: "source_missing" | "render_error";
};

export type LedgerSnapshot = {
  revision: number | null;
  identity: string;
  value: Ledger | null;
};

export type DeploymentSnapshot = {
  sources: OverviewSource[];
  sourceRegistryRevision: number;
  mirrors: OverviewMirror[];
  catalog: Catalog;
  selection: SelectionSnapshot;
  ledger: LedgerSnapshot;
  deploymentState: DeploymentStateFile;
  wouldDeploy: WouldDeployArtifact[];
  artifacts: ArtifactObservation[];
  activeOperation: DeployOperationSummary | null;
  lastOperation: DeployOperationSummary | null;
};

export type DeployPlanAction = {
  action: "add" | "update" | "remove";
  key: CapabilityKey;
  target: DeployTarget;
  sourceId?: string;
  contentSha?: string;
  renderedHash?: string | null;
  removalIntentGeneration?: string;
  artifact: Omit<ArtifactObservation, "key" | "target">;
};

export type DeployPlanBlock = {
  kind: "instruction";
  target: DeployTarget;
  keys: CapabilityKey[];
};

export type InstructionContribution = {
  key: { kind: "instruction"; name: string };
  sourceId: string;
  contentSha: string;
};

export type InstructionWriteOperation = {
  target: DeployTarget;
  contributions: InstructionContribution[];
  renderedHash: string;
  artifact: Omit<ArtifactObservation, "key" | "target">;
};

export type DeployPlan = {
  selectionRevision: number;
  sourceRegistryRevision: number;
  mirrors: OverviewMirror[];
  ledger: { revision: number | null; identity: string };
  deploymentStateRevision: number;
  actions: DeployPlanAction[];
  instructionWrites: InstructionWriteOperation[];
  blocked: DeployPlanBlock[];
};

const TARGETS: readonly DeployTarget[] = ["claude", "codex"];

export function applicableTargets(key: CapabilityKey): DeployTarget[] {
  return key.kind === "plugin" ? ["claude"] : [...TARGETS];
}

function pairId(key: CapabilityKey, target: DeployTarget): string {
  return `${serializeCapabilityKey(key)}\u0000${target}`;
}

function artifactFor(
  observations: readonly ArtifactObservation[],
  key: CapabilityKey,
  target: DeployTarget,
): Omit<ArtifactObservation, "key" | "target"> {
  const found = observations.find(
    (candidate) => pairId(candidate.key, candidate.target) === pairId(key, target),
  );
  if (!found) return { existence: "missing", hash: null };
  return {
    existence: found.existence,
    hash: found.hash,
    ...(found.error ? { error: found.error } : {}),
  };
}

function ledgerCapabilityKeys(ledger: Ledger | null): CapabilityKey[] {
  if (!ledger) return [];
  return [
    ...ledger.skills.map((entry) => ({ kind: "skill" as const, name: entry.name })),
    ...ledger.agentDefs.map((entry) => ({ kind: "agent" as const, name: entry.name })),
    ...ledger.instructions.map((entry) => ({
      kind: "instruction" as const,
      name: entry.name,
    })),
    ...ledger.plugins.map((entry) => ({ kind: "plugin" as const, name: entry.name })),
    ...ledger.bundles.map((entry) => ({ kind: "bundle" as const, name: entry.name })),
  ];
}

export function ledgerOwnershipByKey(
  ledger: Ledger | null,
): ReadonlyMap<string, ReadonlySet<DeployTarget>> {
  const ownership = new Map<string, Set<DeployTarget>>();
  if (!ledger) return ownership;
  const ledgerTargets = ledger.agents.filter(
    (target): target is DeployTarget => target === "claude" || target === "codex",
  );
  for (const key of ledgerCapabilityKeys(ledger)) {
    const applicable = new Set(applicableTargets(key));
    ownership.set(
      serializeCapabilityKey(key),
      new Set(ledgerTargets.filter((target) => applicable.has(target))),
    );
  }
  return ownership;
}

function actionOrder(left: DeployPlanAction, right: DeployPlanAction): number {
  return (
    serializeCapabilityKey(left.key).localeCompare(serializeCapabilityKey(right.key)) ||
    left.target.localeCompare(right.target) ||
    left.action.localeCompare(right.action) ||
    stableJson(left).localeCompare(stableJson(right))
  );
}

function blockOrder(left: DeployPlanBlock, right: DeployPlanBlock): number {
  return (
    left.target.localeCompare(right.target) || stableJson(left).localeCompare(stableJson(right))
  );
}

function instructionWriteOrder(
  left: InstructionWriteOperation,
  right: InstructionWriteOperation,
): number {
  return (
    left.target.localeCompare(right.target) || stableJson(left).localeCompare(stableJson(right))
  );
}

function mirrorOrder(left: OverviewMirror, right: OverviewMirror): number {
  return (
    right.precedence - left.precedence ||
    left.sourceId.localeCompare(right.sourceId) ||
    stableJson(left).localeCompare(stableJson(right))
  );
}

function canonicalPlan(plan: DeployPlan): DeployPlan {
  return {
    selectionRevision: plan.selectionRevision,
    sourceRegistryRevision: plan.sourceRegistryRevision,
    mirrors: [...plan.mirrors].sort(mirrorOrder).map((mirror) => ({ ...mirror })),
    ledger: { revision: plan.ledger.revision, identity: plan.ledger.identity },
    deploymentStateRevision: plan.deploymentStateRevision,
    actions: [...plan.actions].sort(actionOrder).map((action) => ({
      ...action,
      key: { ...action.key },
      artifact: { ...action.artifact },
    })),
    instructionWrites: [...plan.instructionWrites].sort(instructionWriteOrder).map((operation) => ({
      ...operation,
      contributions: operation.contributions.map((contribution) => ({
        ...contribution,
        key: { ...contribution.key },
      })),
      artifact: { ...operation.artifact },
    })),
    blocked: [...plan.blocked].sort(blockOrder).map((block) => ({
      ...block,
      keys: [...block.keys].sort(
        (left, right) =>
          serializeCapabilityKey(left).localeCompare(serializeCapabilityKey(right)) ||
          stableJson(left).localeCompare(stableJson(right)),
      ),
    })),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = Reflect.get(value, key);
    if (nested !== undefined) sorted[key] = stableValue(nested);
  }
  return sorted;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function tokenForPlan(plan: DeployPlan): string {
  return createHash("sha256")
    .update(stableJson(canonicalPlan(plan)))
    .digest("hex");
}

export function identityForLedger(ledger: Ledger | null): string {
  const byName = <T extends { name: string }>(left: T, right: T): number =>
    left.name.localeCompare(right.name) || stableJson(left).localeCompare(stableJson(right));
  const canonical = ledger
    ? {
        kitVersion: ledger.kitVersion,
        agents: [...ledger.agents].sort((left, right) => left.localeCompare(right)),
        skills: [...ledger.skills].sort(byName),
        agentDefs: [...ledger.agentDefs].sort(byName),
        instructions: [...ledger.instructions].sort(byName),
        plugins: [...ledger.plugins].sort(byName),
        bundles: [...ledger.bundles].sort(byName),
      }
    : null;
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

export function buildDeployPlan(snapshot: DeploymentSnapshot): DeployPlan {
  const winner = new Map(
    snapshot.catalog.entries
      .filter((entry) => entry.deployable)
      .map((entry) => [serializeCapabilityKey(entry), entry] as const),
  );
  const records = new Map(
    snapshot.deploymentState.records.map(
      (record) => [pairId(record.key, record.target), record] as const,
    ),
  );
  const wouldDeploy = new Map(
    snapshot.wouldDeploy.map((item) => [pairId(item.key, item.target), item] as const),
  );
  const owned = ledgerOwnershipByKey(snapshot.ledger.value);

  const blockedByTarget = new Map<DeployTarget, CapabilityKey[]>();
  const instructionIntents = new Map<
    DeployTarget,
    { contributions: InstructionContribution[]; renderedHash: string }
  >();
  const selectedInstructions = new Map<
    DeployTarget,
    Array<{ key: { kind: "instruction"; name: string }; rendered?: WouldDeployArtifact }>
  >();
  for (const selected of snapshot.selection.enabled) {
    if (selected.key.kind !== "instruction") continue;
    for (const target of selected.targets) {
      if (!applicableTargets(selected.key).includes(target)) continue;
      const entries = selectedInstructions.get(target) ?? [];
      entries.push({
        key: { kind: "instruction", name: selected.key.name },
        rendered: wouldDeploy.get(pairId(selected.key, target)),
      });
      selectedInstructions.set(target, entries);
    }
  }
  for (const [target, selected] of selectedInstructions) {
    const unavailable = selected.filter(({ key, rendered }) => {
      const available = winner.has(serializeCapabilityKey(key));
      return !available || !rendered || rendered.renderedHash === null || Boolean(rendered.error);
    });
    const hashes = new Set(
      selected.flatMap(({ rendered }) =>
        rendered?.renderedHash && !rendered.error ? [rendered.renderedHash] : [],
      ),
    );
    if (unavailable.length > 0 || hashes.size !== 1) {
      blockedByTarget.set(
        target,
        unavailable.length > 0 ? unavailable.map(({ key }) => key) : selected.map(({ key }) => key),
      );
      continue;
    }
    const renderedHash = [...hashes][0];
    if (!renderedHash) continue;
    const contributions: InstructionContribution[] = [];
    for (const { key, rendered } of selected) {
      if (!rendered || rendered.renderedHash === null || rendered.error) continue;
      contributions.push({
        key,
        sourceId: rendered.sourceId,
        contentSha: rendered.contentSha,
      });
    }
    if (contributions.length !== selected.length) continue;
    instructionIntents.set(target, {
      contributions,
      renderedHash,
    });
  }

  const actions: DeployPlanAction[] = [];
  for (const selected of snapshot.selection.enabled) {
    const selectedWinner = winner.get(serializeCapabilityKey(selected.key));
    if (!selectedWinner) continue;
    for (const target of selected.targets) {
      if (!applicableTargets(selected.key).includes(target)) continue;
      if (selected.key.kind === "instruction" && blockedByTarget.has(target)) continue;
      const id = pairId(selected.key, target);
      const deployment = records.get(id);
      if (!deployment && owned.get(serializeCapabilityKey(selected.key))?.has(target)) continue;
      const rendered = wouldDeploy.get(id);
      if (!rendered || rendered.error) continue;
      const artifact = artifactFor(snapshot.artifacts, selected.key, target);
      let action: "add" | "update" | undefined;
      if (!deployment?.applied) {
        action = "add";
      } else if (selected.key.kind === "plugin" || selected.key.kind === "bundle") {
        if (deployment.applied.contentSha !== rendered.contentSha) action = "update";
      } else if (
        deployment.applied.renderedHash !== rendered.renderedHash ||
        artifact.existence === "missing" ||
        (artifact.existence === "present" &&
          artifact.hash !== null &&
          artifact.hash !== deployment.applied.renderedHash)
      ) {
        action = "update";
      }
      if (!action) continue;
      actions.push({
        action,
        key: selected.key,
        target,
        sourceId: rendered.sourceId,
        contentSha: rendered.contentSha,
        renderedHash: rendered.renderedHash,
        artifact,
      });
    }
  }

  for (const intent of snapshot.selection.removalIntents) {
    if (intent.key.kind === "plugin" || intent.key.kind === "bundle") continue;
    for (const target of intent.targets) {
      if (!applicableTargets(intent.key).includes(target)) continue;
      if (intent.key.kind === "instruction" && blockedByTarget.has(target)) continue;
      if (!records.get(pairId(intent.key, target))?.applied) continue;
      actions.push({
        action: "remove",
        key: intent.key,
        target,
        ...(intent.generation ? { removalIntentGeneration: intent.generation } : {}),
        artifact: artifactFor(snapshot.artifacts, intent.key, target),
      });
    }
  }

  const instructionActionTargets = new Set(
    actions.filter((action) => action.key.kind === "instruction").map((action) => action.target),
  );
  const instructionWrites: InstructionWriteOperation[] = [];
  for (const [target, intent] of instructionIntents) {
    if (!instructionActionTargets.has(target)) continue;
    const first = intent.contributions[0];
    if (!first) continue;
    instructionWrites.push({
      target,
      contributions: intent.contributions,
      renderedHash: intent.renderedHash,
      artifact: artifactFor(snapshot.artifacts, first.key, target),
    });
  }

  return canonicalPlan({
    selectionRevision: snapshot.selection.revision,
    sourceRegistryRevision: snapshot.sourceRegistryRevision,
    mirrors: snapshot.mirrors,
    ledger: { revision: snapshot.ledger.revision, identity: snapshot.ledger.identity },
    deploymentStateRevision: snapshot.deploymentState.revision,
    actions,
    instructionWrites,
    blocked: [...blockedByTarget].map(([target, keys]) => ({
      kind: "instruction",
      target,
      keys,
    })),
  });
}
