import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CapabilityKey,
  parseCapabilityKey,
  serializeCapabilityKey,
} from "@hive/capability-schema";
import {
  type Catalog,
  type DeployDiff,
  DeploymentOverview,
  type DeployOperationSummary,
  type DeployTarget,
  type Ledger,
  type OverviewCatalogState,
  type OverviewLastAttempt,
  type OverviewMirror,
  type OverviewRow,
  type OverviewTargetState,
  type ReconciliationState,
  type SelectionSnapshot,
  type Source,
  type TargetObservation,
} from "@hive/contract";
import {
  deployedAgentPath,
  deployedInstructionPath,
  deployedSkillDir,
  hashDeployedAgent,
  hashDeployedInstruction,
  hashDeployedSkill,
  sha256,
} from "./deploy/artifact-hash.ts";
import { loadSnippets } from "./deploy/sources.ts";
import {
  type ArtifactObservation,
  applicableTargets,
  buildDeployPlan,
  type DeploymentSnapshot,
  identityForLedger,
  ledgerOwnershipByKey,
  stableJson,
  tokenForPlan,
  type WouldDeployArtifact,
} from "./deploy-plan.ts";
import { type DeploymentStateFile, type DeploymentStateRecord } from "./deployment-state.ts";
import { readProvenance } from "./mirror.ts";
import { type ResolvedItem, renderedInstructionHash, renderedNamedHash } from "./selection.ts";
import type { DeployTargets } from "./targets.ts";

function pairId(key: CapabilityKey, target: DeployTarget): string {
  return `${serializeCapabilityKey(key)}\u0000${target}`;
}

function ledgerKeySet(ledger: Ledger | null): Set<string> {
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

function catalogState(entries: DeploymentSnapshot["catalog"]["entries"]): OverviewCatalogState {
  if (entries.length === 0) return "unavailable";
  if (entries.some((entry) => entry.deployable)) return "deployable";
  if (entries.every((entry) => entry.shadowed)) return "shadowed";
  return "blocked";
}

function attempt(record: DeploymentStateRecord | undefined): OverviewLastAttempt {
  if (!record) return { state: "none" };
  const value = record.lastAttempt;
  if (value.outcome === "succeeded") {
    return {
      state: "succeeded",
      operationId: value.operationId,
      attemptedAt: value.attemptedAt,
    };
  }
  return {
    state: "failed",
    operationId: value.operationId,
    attemptedAt: value.attemptedAt,
    code: value.outcome === "interrupted" ? "interrupted" : (value.code ?? "unknown"),
    ...(value.detail ? { detail: value.detail } : {}),
  };
}

function latestAttempt(records: readonly DeploymentStateRecord[]): OverviewLastAttempt {
  const latest = [...records].sort(
    (left, right) => right.lastAttempt.attemptedAt - left.lastAttempt.attemptedAt,
  )[0];
  return attempt(latest);
}

function targetObservation(
  snapshot: DeploymentSnapshot,
  key: CapabilityKey,
  target: DeployTarget,
  record: DeploymentStateRecord | undefined,
  ledgerOwned: boolean,
): TargetObservation {
  if (key.kind === "plugin" || key.kind === "bundle") {
    return ledgerOwned || record?.applied ? "recorded_unverified" : "missing";
  }
  const artifact = snapshot.artifacts.find(
    (candidate) => pairId(candidate.key, candidate.target) === pairId(key, target),
  );
  if (artifact?.existence === "error") return "verification_error";
  if (!artifact || artifact.existence === "missing") return "missing";
  if (!record?.applied || artifact.hash === null) return "present_unverified";
  return artifact.hash === record.applied.renderedHash ? "verified" : "drifted";
}

function aggregateReconciliation(targets: readonly OverviewTargetState[]): ReconciliationState {
  const priority: readonly ReconciliationState[] = [
    "pending_remove",
    "pending_update",
    "pending_add",
    "manual_install_required",
    "manual_removal_required",
    "orphaned",
    "waiting_for_source",
    "unmanaged_owned",
    "in_sync",
  ];
  return (
    priority.find((state) => targets.some((target) => target.reconciliation === state)) ?? "in_sync"
  );
}

function currentDiff(plan: ReturnType<typeof buildDeployPlan>): DeployDiff {
  const byKey = new Map<string, DeployDiff["entries"][number]>();
  const rank = { removed: 3, changed: 2, added: 1 } as const;
  for (const action of plan.actions) {
    const change =
      action.action === "add" ? "added" : action.action === "update" ? "changed" : "removed";
    const id = serializeCapabilityKey(action.key);
    const prior = byKey.get(id);
    if (prior && rank[prior.change] >= rank[change]) continue;
    byKey.set(id, {
      ...action.key,
      change,
      ...(action.key.kind === "instruction" &&
      action.action === "add" &&
      action.artifact.existence === "present"
        ? { replacesUserFile: true }
        : {}),
    });
  }
  return {
    entries: [...byKey.values()].sort(
      (left, right) =>
        serializeCapabilityKey(left).localeCompare(serializeCapabilityKey(right)) ||
        left.change.localeCompare(right.change),
    ),
  };
}

export function buildOverview(snapshot: DeploymentSnapshot): DeploymentOverview {
  const plan = buildDeployPlan(snapshot);
  const keys = new Map<string, CapabilityKey>();
  for (const entry of snapshot.catalog.entries) keys.set(serializeCapabilityKey(entry), entry);
  for (const entry of snapshot.selection.enabled)
    keys.set(serializeCapabilityKey(entry.key), entry.key);
  for (const entry of snapshot.selection.removalIntents)
    keys.set(serializeCapabilityKey(entry.key), entry.key);
  for (const record of snapshot.deploymentState.records)
    keys.set(serializeCapabilityKey(record.key), record.key);
  for (const id of ledgerKeySet(snapshot.ledger.value)) {
    keys.set(id, parseCapabilityKey(id));
  }

  const recordsByPair = new Map(
    snapshot.deploymentState.records.map(
      (record) => [pairId(record.key, record.target), record] as const,
    ),
  );
  const actionByPair = new Map(
    plan.actions.map((action) => [pairId(action.key, action.target), action] as const),
  );
  const unmanagedInstructionTargets = new Set(
    plan.blocked.filter((block) => block.reason === "unmanaged_owned").map((block) => block.target),
  );
  const wouldByPair = new Map(
    snapshot.wouldDeploy.map((item) => [pairId(item.key, item.target), item] as const),
  );
  const selectedByKey = new Map(
    snapshot.selection.enabled.map((entry) => [serializeCapabilityKey(entry.key), entry] as const),
  );
  const intentTargetsByKey = new Map<string, Set<DeployTarget>>();
  for (const entry of snapshot.selection.removalIntents) {
    const id = serializeCapabilityKey(entry.key);
    const targets = intentTargetsByKey.get(id) ?? new Set<DeployTarget>();
    for (const target of entry.targets) targets.add(target);
    intentTargetsByKey.set(id, targets);
  }
  const owned = ledgerKeySet(snapshot.ledger.value);
  const ownership = ledgerOwnershipByKey(snapshot.ledger.value);

  const rows: OverviewRow[] = [...keys.values()]
    .sort((left, right) =>
      serializeCapabilityKey(left).localeCompare(serializeCapabilityKey(right)),
    )
    .map((key) => {
      const id = serializeCapabilityKey(key);
      const variants = snapshot.catalog.entries
        .filter((entry) => serializeCapabilityKey(entry) === id)
        .sort(
          (left, right) =>
            Number(right.deployable) - Number(left.deployable) ||
            Number(left.shadowed) - Number(right.shadowed) ||
            left.contentSha.localeCompare(right.contentSha),
        );
      const state = catalogState(variants);
      const winner = variants.find((entry) => entry.deployable);
      const selected = selectedByKey.get(id);
      const intentTargets = intentTargetsByKey.get(id);
      const keyRecords = snapshot.deploymentState.records.filter(
        (record) => serializeCapabilityKey(record.key) === id,
      );
      const isLedgerKey = owned.has(id);
      const targets: OverviewTargetState[] = applicableTargets(key).map((target) => {
        const record = recordsByPair.get(pairId(key, target));
        const selectedOnTarget = selected?.targets.includes(target) ?? false;
        const intentOnTarget = intentTargets?.has(target) ?? false;
        const ledgerOwned = ownership.get(id)?.has(target) ?? false;
        const action = actionByPair.get(pairId(key, target));
        let reconciliation: ReconciliationState = "in_sync";
        if (action) {
          reconciliation =
            action.action === "add"
              ? "pending_add"
              : action.action === "update"
                ? "pending_update"
                : "pending_remove";
        } else if (
          key.kind === "instruction" &&
          unmanagedInstructionTargets.has(target) &&
          (selectedOnTarget || ledgerOwned)
        ) {
          reconciliation = "unmanaged_owned";
        } else if (intentOnTarget && (key.kind === "plugin" || key.kind === "bundle")) {
          reconciliation = "manual_removal_required";
        } else if (
          selectedOnTarget &&
          winner &&
          (key.kind === "plugin" || key.kind === "bundle") &&
          ((!record?.applied && !ledgerOwned) ||
            (record?.applied && record.applied.contentSha !== winner.contentSha))
        ) {
          reconciliation = "manual_install_required";
        } else if (selectedOnTarget && !winner) {
          reconciliation = record?.applied || ledgerOwned ? "orphaned" : "waiting_for_source";
        } else if (ledgerOwned && !record) {
          reconciliation = "unmanaged_owned";
        } else if (selectedOnTarget && wouldByPair.get(pairId(key, target))?.error) {
          reconciliation = "waiting_for_source";
        } else if (!selectedOnTarget && !intentOnTarget && record?.applied && !winner) {
          reconciliation = "orphaned";
        }
        return {
          target,
          desired: selectedOnTarget ? "on" : "off",
          reconciliation,
          observation: targetObservation(snapshot, key, target, record, ledgerOwned),
          lastAttempt: attempt(record),
        };
      });
      const reconciliation = aggregateReconciliation(targets);
      return {
        key,
        catalog: state,
        desired: selected ? "on" : "off",
        reconciliation:
          reconciliation === "in_sync" && isLedgerKey && keyRecords.length === 0
            ? "unmanaged_owned"
            : reconciliation,
        lastAttempt: latestAttempt(keyRecords),
        applicableTargets: applicableTargets(key),
        targets,
        variants: variants.map((entry) => ({
          ...entry,
          catalog: entry.deployable ? "deployable" : entry.shadowed ? "shadowed" : "blocked",
        })),
      };
    });

  return DeploymentOverview.parse({
    sources: [...snapshot.sources].sort(
      (left, right) => right.rank - left.rank || left.id.localeCompare(right.id),
    ),
    sourceRegistryRevision: snapshot.sourceRegistryRevision,
    mirrors: [...snapshot.mirrors].sort(
      (left, right) =>
        right.precedence - left.precedence || left.sourceId.localeCompare(right.sourceId),
    ),
    selectionRevision: snapshot.selection.revision,
    variants: snapshot.catalog.entries,
    rows,
    diff: currentDiff(plan),
    planToken: tokenForPlan(plan),
    activeOperation: snapshot.activeOperation,
    lastOperation: snapshot.lastOperation,
  });
}

export type CaptureDeploymentSnapshotInput = {
  sourceRegistry: { revision: number; sources: readonly Source[] };
  catalog: Catalog;
  selection: SelectionSnapshot;
  ledger: Ledger | null;
  deploymentState: DeploymentStateFile;
  activeOperation?: DeployOperationSummary | null;
  lastOperation?: DeployOperationSummary | null;
};

const mirrorTreeIdentityCache = new Map<
  string,
  { dev: number; ino: number; mtimeMs: number; ctimeMs: number; identity: string }
>();

function mirrorTreeIdentity(root: string): string {
  const stat = lstatSync(root);
  const cached = mirrorTreeIdentityCache.get(root);
  if (
    cached?.dev === stat.dev &&
    cached.ino === stat.ino &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs
  ) {
    return cached.identity;
  }
  const hash = createHash("sha256");
  const walk = (directory: string, relative: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (!relative && entry.name === ".hive-mirror.json") continue;
      const path = join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        walk(path, rel);
      } else if (entry.isFile()) {
        hash.update(`f\0${rel}\0`);
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  walk(root, "");
  const identity = hash.digest("hex");
  if (!mirrorTreeIdentityCache.has(root) && mirrorTreeIdentityCache.size >= 256) {
    const oldest = mirrorTreeIdentityCache.keys().next().value;
    if (oldest !== undefined) mirrorTreeIdentityCache.delete(oldest);
  }
  mirrorTreeIdentityCache.set(root, {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    identity,
  });
  return identity;
}

export function readMirrorIdentity(root: string): string {
  const provenance = readProvenance(root);
  if (!provenance) return mirrorTreeIdentity(root);
  return sha256(
    JSON.stringify({
      transport: provenance.transport ?? "legacy-git",
      resolvedCommit: provenance.resolvedCommit ?? provenance.sha,
      treeIdentity: provenance.treeIdentity ?? null,
      dirty: provenance.dirty ?? false,
    }),
  );
}

function captureMirrors(
  targets: DeployTargets,
  activeSources: readonly Source[],
): OverviewMirror[] {
  return activeSources.map((source) => {
    try {
      return {
        sourceId: source.id,
        precedence: source.rank,
        identity: readMirrorIdentity(targets.mirrorRoot(source.id)),
      };
    } catch {
      return {
        sourceId: source.id,
        precedence: source.rank,
        identity: null,
        error: "unavailable" as const,
      };
    }
  });
}

function probeArtifact(
  targets: DeployTargets,
  key: CapabilityKey,
  target: DeployTarget,
): ArtifactObservation {
  const path =
    key.kind === "skill"
      ? deployedSkillDir(targets, key.name, target)
      : key.kind === "agent"
        ? deployedAgentPath(targets, key.name, target)
        : deployedInstructionPath(targets, target);
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { key, target, existence: "missing", hash: null };
    }
    return { key, target, existence: "error", hash: null, error: "read" };
  }
  try {
    const hash =
      key.kind === "skill"
        ? hashDeployedSkill(targets, key.name, target)
        : key.kind === "agent"
          ? hashDeployedAgent(targets, key.name, target)
          : hashDeployedInstruction(targets, target);
    return hash === null
      ? { key, target, existence: "missing", hash: null }
      : { key, target, existence: "present", hash };
  } catch {
    return { key, target, existence: "error", hash: null, error: "read" };
  }
}

function snapshotKeys(input: CaptureDeploymentSnapshotInput): CapabilityKey[] {
  const keys = new Map<string, CapabilityKey>();
  for (const entry of input.catalog.entries) keys.set(serializeCapabilityKey(entry), entry);
  for (const entry of input.selection.enabled)
    keys.set(serializeCapabilityKey(entry.key), entry.key);
  for (const entry of input.selection.removalIntents)
    keys.set(serializeCapabilityKey(entry.key), entry.key);
  for (const record of input.deploymentState.records)
    keys.set(serializeCapabilityKey(record.key), record.key);
  for (const serialized of ledgerKeySet(input.ledger))
    keys.set(serialized, parseCapabilityKey(serialized));
  return [...keys.values()].sort((left, right) =>
    serializeCapabilityKey(left).localeCompare(serializeCapabilityKey(right)),
  );
}

function wouldDeployArtifacts(
  targets: DeployTargets,
  input: CaptureDeploymentSnapshotInput,
  activeSources: readonly Source[],
): WouldDeployArtifact[] {
  const winner = new Map(
    input.catalog.entries
      .filter((entry) => entry.deployable)
      .map((entry) => [serializeCapabilityKey(entry), entry] as const),
  );
  let snippets: Map<string, string> | undefined;
  let snippetError = false;
  try {
    snippets = loadSnippets(activeSources.map((source) => targets.mirrorRoot(source.id)));
  } catch {
    snippetError = true;
  }
  const artifacts: WouldDeployArtifact[] = [];
  for (const selected of input.selection.enabled.filter(
    (entry) => entry.key.kind !== "instruction",
  )) {
    const entry = winner.get(serializeCapabilityKey(selected.key));
    if (!entry) continue;
    const sourceId = entry.sourceIds[0];
    if (!sourceId) continue;
    for (const target of selected.targets) {
      if (!applicableTargets(selected.key).includes(target)) continue;
      if (selected.key.kind === "plugin" || selected.key.kind === "bundle") {
        artifacts.push({
          key: selected.key,
          target,
          sourceId,
          contentSha: entry.contentSha,
          renderedHash: null,
        });
        continue;
      }
      if (snippetError || !snippets) {
        artifacts.push({
          key: selected.key,
          target,
          sourceId,
          contentSha: entry.contentSha,
          renderedHash: null,
          error: "render_error",
        });
        continue;
      }
      if (selected.key.kind !== "skill" && selected.key.kind !== "agent") continue;
      try {
        const renderedHash = renderedNamedHash(
          targets.mirrorRoot(sourceId),
          snippets,
          selected.key.kind,
          selected.key.name,
          target,
        );
        artifacts.push({
          key: selected.key,
          target,
          sourceId,
          contentSha: entry.contentSha,
          renderedHash,
          ...(renderedHash === null ? { error: "source_missing" as const } : {}),
        });
      } catch {
        artifacts.push({
          key: selected.key,
          target,
          sourceId,
          contentSha: entry.contentSha,
          renderedHash: null,
          error: "render_error",
        });
      }
    }
  }

  for (const target of ["claude", "codex"] as const) {
    const desired = input.selection.enabled.filter(
      (entry) => entry.key.kind === "instruction" && entry.targets.includes(target),
    );
    if (desired.length === 0) continue;
    const resolved: ResolvedItem[] = [];
    let complete = true;
    for (const selected of desired) {
      const entry = winner.get(serializeCapabilityKey(selected.key));
      const sourceId = entry?.sourceIds[0];
      if (!entry || !sourceId) {
        complete = false;
        continue;
      }
      resolved.push({ name: selected.key.name, sourceId });
    }
    let renderedHash: string | null = null;
    let renderError = false;
    if (complete) {
      try {
        renderedHash = renderedInstructionHash(resolved, targets);
      } catch {
        renderError = true;
      }
    }
    for (const selected of desired) {
      const entry = winner.get(serializeCapabilityKey(selected.key));
      const sourceId = entry?.sourceIds[0];
      if (!entry || !sourceId) continue;
      artifacts.push({
        key: selected.key,
        target,
        sourceId,
        contentSha: entry.contentSha,
        renderedHash,
        ...(!complete || renderedHash === null
          ? { error: renderError ? ("render_error" as const) : ("source_missing" as const) }
          : {}),
      });
    }
  }
  return artifacts;
}

export function captureDeploymentSnapshot(
  targets: DeployTargets,
  input: CaptureDeploymentSnapshotInput,
  capturedMirrors?: OverviewMirror[],
): DeploymentSnapshot {
  const activeSources = input.sourceRegistry.sources.filter((source) => source.active);
  const sources = input.sourceRegistry.sources.map((source) => ({
    id: source.id,
    label: source.label,
    kind: source.kind,
    active: source.active,
    rank: source.rank,
  }));
  const mirrors = capturedMirrors ?? captureMirrors(targets, activeSources);
  const ledgerOwned = ledgerKeySet(input.ledger);
  const ledgerTargets = new Set(
    (input.ledger?.agents ?? []).filter(
      (target): target is DeployTarget => target === "claude" || target === "codex",
    ),
  );
  const applied = new Set(
    input.deploymentState.records
      .filter((record) => record.applied)
      .map((record) => pairId(record.key, record.target)),
  );
  const artifacts = snapshotKeys(input).flatMap((key) =>
    applicableTargets(key).map((target) => {
      if (key.kind !== "plugin" && key.kind !== "bundle") {
        return probeArtifact(targets, key, target);
      }
      const recorded =
        (ledgerOwned.has(serializeCapabilityKey(key)) && ledgerTargets.has(target)) ||
        applied.has(pairId(key, target));
      return {
        key,
        target,
        existence: recorded ? ("present" as const) : ("missing" as const),
        hash: null,
      };
    }),
  );
  return {
    sources,
    sourceRegistryRevision: input.sourceRegistry.revision,
    mirrors,
    catalog: input.catalog,
    selection: input.selection,
    ledger: {
      revision: null,
      identity: identityForLedger(input.ledger),
      value: input.ledger,
    },
    deploymentState: input.deploymentState,
    wouldDeploy: wouldDeployArtifacts(targets, input, activeSources),
    artifacts,
    activeOperation: input.activeOperation ?? null,
    lastOperation: input.lastOperation ?? null,
  };
}

export type DeploymentSnapshotReaders = {
  readSourceRegistry(): { revision: number; sources: readonly Source[] };
  readCatalog(activeSources: readonly Source[]): Catalog;
  readLedger(): Ledger | null;
  readSelection(ledger: Ledger | null): SelectionSnapshot;
  readDeploymentState(): DeploymentStateFile;
  readActiveOperation?(): DeployOperationSummary | null;
  readLastOperation?(): DeployOperationSummary | null;
};

export class DeploymentSnapshotChangedError extends Error {
  readonly code = "deployment_snapshot_changed";

  constructor() {
    super("deployment_snapshot_changed");
    this.name = "DeploymentSnapshotChangedError";
  }
}

export function captureCoherentDeploymentSnapshot(
  targets: DeployTargets,
  readers: DeploymentSnapshotReaders,
  maxAttempts = 3,
): DeploymentSnapshot {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = readers.readSourceRegistry();
    const activeSources = before.sources.filter((source) => source.active);
    const beforeMirrors = captureMirrors(targets, activeSources);
    const ledger = readers.readLedger();
    const snapshot = captureDeploymentSnapshot(
      targets,
      {
        sourceRegistry: before,
        catalog: readers.readCatalog(activeSources),
        selection: readers.readSelection(ledger),
        ledger,
        deploymentState: readers.readDeploymentState(),
        activeOperation: readers.readActiveOperation?.() ?? null,
        lastOperation: readers.readLastOperation?.() ?? null,
      },
      beforeMirrors,
    );
    const afterMirrors = captureMirrors(targets, activeSources);
    const after = readers.readSourceRegistry();
    if (
      before.revision === after.revision &&
      stableJson(beforeMirrors) === stableJson(afterMirrors)
    ) {
      return snapshot;
    }
  }
  throw new DeploymentSnapshotChangedError();
}
