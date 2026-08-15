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
  artifact: Omit<ArtifactObservation, "key" | "target">;
};

export type DeployPlanBlock = {
  kind: "instruction";
  target: DeployTarget;
  keys: CapabilityKey[];
};

export type DeployPlan = {
  selectionRevision: number;
  sourceRegistryRevision: number;
  mirrors: OverviewMirror[];
  ledger: { revision: number | null; identity: string };
  deploymentStateRevision: number;
  actions: DeployPlanAction[];
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

function ledgerKeys(ledger: Ledger | null): Set<string> {
  const keys = new Set<string>();
  if (!ledger) return keys;
  for (const entry of ledger.skills)
    keys.add(serializeCapabilityKey({ kind: "skill", name: entry.name }));
  for (const entry of ledger.agentDefs)
    keys.add(serializeCapabilityKey({ kind: "agent", name: entry.name }));
  for (const entry of ledger.instructions)
    keys.add(serializeCapabilityKey({ kind: "instruction", name: entry.name }));
  for (const entry of ledger.plugins)
    keys.add(serializeCapabilityKey({ kind: "plugin", name: entry.name }));
  for (const entry of ledger.bundles)
    keys.add(serializeCapabilityKey({ kind: "bundle", name: entry.name }));
  return keys;
}

function actionOrder(left: DeployPlanAction, right: DeployPlanAction): number {
  return (
    serializeCapabilityKey(left.key).localeCompare(serializeCapabilityKey(right.key)) ||
    left.target.localeCompare(right.target) ||
    left.action.localeCompare(right.action)
  );
}

function blockOrder(left: DeployPlanBlock, right: DeployPlanBlock): number {
  return left.target.localeCompare(right.target);
}

function mirrorOrder(left: OverviewMirror, right: OverviewMirror): number {
  return right.precedence - left.precedence || left.sourceId.localeCompare(right.sourceId);
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
    blocked: [...plan.blocked].sort(blockOrder).map((block) => ({
      ...block,
      keys: [...block.keys].sort((left, right) =>
        serializeCapabilityKey(left).localeCompare(serializeCapabilityKey(right)),
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
  return createHash("sha256").update(stableJson(ledger)).digest("hex");
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
  const owned = ledgerKeys(snapshot.ledger.value);

  const blockedByTarget = new Map<DeployTarget, CapabilityKey[]>();
  for (const selected of snapshot.selection.enabled) {
    if (selected.key.kind !== "instruction") continue;
    for (const target of selected.targets) {
      const available = winner.has(serializeCapabilityKey(selected.key));
      const rendered = wouldDeploy.get(pairId(selected.key, target));
      if (available && rendered && !rendered.error) continue;
      const keys = blockedByTarget.get(target) ?? [];
      keys.push(selected.key);
      blockedByTarget.set(target, keys);
    }
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
      if (!deployment && owned.has(serializeCapabilityKey(selected.key))) continue;
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
        artifact: artifactFor(snapshot.artifacts, intent.key, target),
      });
    }
  }

  return canonicalPlan({
    selectionRevision: snapshot.selection.revision,
    sourceRegistryRevision: snapshot.sourceRegistryRevision,
    mirrors: snapshot.mirrors,
    ledger: { revision: snapshot.ledger.revision, identity: snapshot.ledger.identity },
    deploymentStateRevision: snapshot.deploymentState.revision,
    actions,
    blocked: [...blockedByTarget].map(([target, keys]) => ({
      kind: "instruction",
      target,
      keys,
    })),
  });
}
