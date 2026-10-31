import { lstatSync, readFileSync } from "node:fs";
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
import type { DeclaredTargets } from "./capability-targets.ts";
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
import {
  managedNpxBundleHash,
  managedNpxBundleMeta,
  probeManagedNpxBundle,
} from "./deploy/npx-bundle.ts";
import {
  agentSourceDir,
  bundleMeta,
  createSnippetResolver,
  instructionBody,
  pluginMeta,
  renderedSkillFiles,
  type SnippetResolver,
} from "./deploy/sources.ts";
import { resolveTileBundle, type TileBundle, tileInstalled } from "./deploy/tile-bundle.ts";
import { transformAgent, transformInstructions } from "./deploy/transforms.ts";
import {
  type ArtifactObservation,
  applicableTargets,
  buildDeployPlan,
  type DeploymentSnapshot,
  identityForLedger,
  ledgerOwnershipByKey,
  type PluginDeployInfo,
  stableJson,
  tokenForPlan,
  type WouldDeployArtifact,
} from "./deploy-plan.ts";
import { type DeploymentStateFile, type DeploymentStateRecord } from "./deployment-state.ts";
import { readMirrorIdentity, readMirrorRecord } from "./mirror.ts";
import { tileById, tileForLocator } from "./recipes/tiles.ts";
import { selectionUnits } from "./selection-units.ts";
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
  const managedBundle =
    key.kind === "bundle" &&
    snapshot.wouldDeploy.some(
      (item) => pairId(item.key, item.target) === pairId(key, target) && item.renderedHash !== null,
    );
  if (key.kind === "plugin" || (key.kind === "bundle" && !managedBundle)) {
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
  const units = selectionUnits(snapshot.catalog, snapshot.sources);
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
  const satisfiedIntentPairs = new Set(
    plan.satisfiedRemovalIntents.map((intent) => pairId(intent.key, intent.target)),
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
    .map((key): OverviewRow => {
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
      const targets: OverviewTargetState[] = applicableTargets(key, snapshot).map((target) => {
        const record = recordsByPair.get(pairId(key, target));
        const selectedOnTarget = selected?.targets.includes(target) ?? false;
        const intentOnTarget =
          (intentTargets?.has(target) ?? false) && !satisfiedIntentPairs.has(pairId(key, target));
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
        applicableTargets: applicableTargets(key, snapshot),
        targets,
        variants: variants.map((entry) => ({
          ...entry,
          catalog: entry.deployable ? "deployable" : entry.shadowed ? "shadowed" : "blocked",
        })),
        wholeSourceId: units.wholeSourceOf(key),
      };
    })
    .filter(
      (row) =>
        !(
          row.catalog === "unavailable" &&
          row.desired === "off" &&
          row.reconciliation === "in_sync" &&
          row.lastAttempt.state !== "failed" &&
          row.targets.every((target) => target.observation === "missing")
        ),
    );

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

function captureMirrors(
  targets: DeployTargets,
  activeSources: readonly Source[],
): OverviewMirror[] {
  return activeSources.map((source) => {
    const identity = readMirrorIdentity(targets.mirrorRoot(source.id));
    return identity === null
      ? { sourceId: source.id, precedence: source.rank, identity, error: "unavailable" as const }
      : { sourceId: source.id, precedence: source.rank, identity };
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

function pluginDeployInfo(
  targets: DeployTargets,
  catalog: Catalog,
): ReadonlyMap<string, PluginDeployInfo> {
  const plugins = new Map<string, PluginDeployInfo>();
  for (const entry of catalog.entries) {
    const sourceId = entry.sourceIds[0];
    if (entry.kind !== "plugin" || !entry.deployable || !sourceId) continue;
    const meta = pluginMeta(targets.mirrorRoot(sourceId), entry.name);
    if (meta) plugins.set(entry.name, { targets: meta.targets });
  }
  return plugins;
}

function bundleDeployInfo(
  targets: DeployTargets,
  catalog: Catalog,
): ReadonlyMap<string, PluginDeployInfo> {
  const bundles = new Map<string, PluginDeployInfo>();
  for (const entry of catalog.entries) {
    const sourceId = entry.sourceIds[0];
    if (entry.kind !== "bundle" || !entry.deployable || !sourceId) continue;
    const declared = bundleMeta(targets.mirrorRoot(sourceId), entry.name)?.targets;
    if (declared) bundles.set(entry.name, { targets: declared });
  }
  return bundles;
}

// The Tile installer a winning bundle pointer resolves to on `target`, or null
// when the pointer is not a trusted Tile installer.
function winningTileBundle(
  targets: DeployTargets,
  sourceTiles: ReadonlyMap<string, string>,
  selection: SelectionSnapshot,
  key: CapabilityKey,
  sourceId: string,
  target: DeployTarget,
): TileBundle | null {
  const meta = bundleMeta(targets.mirrorRoot(sourceId), key.name);
  if (meta?.installerKind !== "tile") return null;
  const selected =
    selection.enabled.find(
      (entry) => serializeCapabilityKey(entry.key) === serializeCapabilityKey(key),
    )?.targets ?? [];
  return resolveTileBundle(
    meta,
    tileById(sourceTiles.get(sourceId) ?? ""),
    target,
    selected,
    targets,
  );
}

// A resolved deploy item: the leaf name plus the WINNING Source's id (whose Mirror
// the Deploy reads). Self-describing — the anti-corruption seam (ADR-0023:85-86):
// Deploy never recomputes precedence or counts Sources.
type ResolvedItem = { name: string; sourceId: string };

// Hash the rendered content a deploy WOULD write for a skill/agent under `target`,
// reading from the WINNER's Mirror (the single resolved mirrorRoot for this name),
// so a same-name new-body change is detectable. Matches what Deploy staging writes
// per target (incl. the Codex sidecar) so the hash is comparable to the deployed
// artifact's hash. Returns null when the source isn't in the winner's Mirror.
function renderedNamedHash(
  mirrorRoot: string,
  snippets: SnippetResolver,
  kind: "skill" | "agent",
  name: string,
  target: DeployTarget,
): string | null {
  if (kind === "skill") {
    const files = renderedSkillFiles(mirrorRoot, name, target, snippets);
    return files === null ? null : hashSkillFiles(files);
  }
  const src = agentSourceDir(mirrorRoot, name);
  if (!src) return null;
  const raw = readFileSync(join(src, "AGENT.md"), "utf8");
  const rendered = transformAgent({ name, raw }, snippets());
  return sha256(target === "claude" ? rendered.claudeMd : rendered.codexToml);
}

// Hash the concatenated instruction whole-file a deploy WOULD write. Each
// instruction resolves to ITS OWN winner Mirror — two instructions in one
// selection may be won by different Sources, so a single shared mirrorRoot would
// hash the wrong bytes. Concatenation order is the resolved-array order
// (deterministic, identical to the deploy path).
function renderedInstructionHash(
  items: readonly ResolvedItem[],
  targets: DeployTargets,
): string | null {
  const bodies = items.map((item) => instructionBody(targets.mirrorRoot(item.sourceId), item.name));
  // A selected unavailable contribution blocks this whole-file render.
  if (!bodies.every((body): body is string => body !== null)) return null;
  return sha256(transformInstructions(bodies));
}

function wouldDeployArtifacts(
  targets: DeployTargets,
  input: CaptureDeploymentSnapshotInput,
  activeSources: readonly Source[],
  declared: DeclaredTargets,
  sourceTiles: ReadonlyMap<string, string>,
): WouldDeployArtifact[] {
  const winner = new Map(
    input.catalog.entries
      .filter((entry) => entry.deployable)
      .map((entry) => [serializeCapabilityKey(entry), entry] as const),
  );
  const snippets = createSnippetResolver(
    activeSources.map((source) => targets.mirrorRoot(source.id)),
  );
  const artifacts: WouldDeployArtifact[] = [];
  const requested = new Map<string, { key: CapabilityKey; target: DeployTarget }>();
  for (const selection of [
    ...input.selection.enabled,
    ...input.selection.removalIntents.filter(
      ({ key }) => key.kind === "plugin" || key.kind === "bundle",
    ),
  ]) {
    if (selection.key.kind === "instruction") continue;
    for (const target of selection.targets) {
      if (!applicableTargets(selection.key, declared).includes(target)) continue;
      requested.set(pairId(selection.key, target), { key: selection.key, target });
    }
  }
  for (const selected of requested.values()) {
    const entry = winner.get(serializeCapabilityKey(selected.key));
    if (!entry) continue;
    const sourceId = entry.sourceIds[0];
    if (!sourceId) continue;
    const { target } = selected;
    if (selected.key.kind === "plugin") {
      artifacts.push({
        key: selected.key,
        target,
        sourceId,
        contentSha: entry.contentSha,
        renderedHash: null,
      });
      continue;
    }
    if (selected.key.kind === "bundle") {
      const parsed = bundleMeta(targets.mirrorRoot(sourceId), selected.key.name);
      const managed = parsed ? managedNpxBundleMeta(parsed, target, targets) : null;
      const tile = winningTileBundle(
        targets,
        sourceTiles,
        input.selection,
        selected.key,
        sourceId,
        target,
      );
      artifacts.push({
        key: selected.key,
        target,
        sourceId,
        contentSha: entry.contentSha,
        renderedHash: managed
          ? managedNpxBundleHash(managed, target)
          : (tile?.renderedHash ?? null),
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
  captured: CaptureDeploymentSnapshotInput,
  capturedMirrors?: OverviewMirror[],
): DeploymentSnapshot {
  const sources = captured.sourceRegistry.sources.map((source) => ({
    id: source.id,
    label: source.label,
    kind: source.kind,
    active: source.active,
    rank: source.rank,
    recipe: readMirrorRecord(targets.mirrorRoot(source.id))?.recipe ?? null,
  }));
  // The Overview and the Deploy plan read the closed Selection, so neither sees
  // a partial whole unit.
  const input = {
    ...captured,
    selection: selectionUnits(captured.catalog, sources).close(captured.selection),
  };
  const activeSources = input.sourceRegistry.sources.filter((source) => source.active);
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
  const plugins = pluginDeployInfo(targets, input.catalog);
  const bundles = bundleDeployInfo(targets, input.catalog);
  const declared = { plugins, bundles };
  const sourceTiles = new Map(
    input.sourceRegistry.sources.flatMap((source) => {
      const tile = tileForLocator(source.locator);
      return tile ? [[source.id, tile.id] as const] : [];
    }),
  );
  const wouldDeploy = wouldDeployArtifacts(targets, input, activeSources, declared, sourceTiles);
  const wouldByPair = new Map(
    wouldDeploy.map((item) => [pairId(item.key, item.target), item] as const),
  );
  const winner = new Map(
    input.catalog.entries
      .filter((entry) => entry.deployable)
      .map((entry) => [serializeCapabilityKey(entry), entry] as const),
  );
  const artifacts = snapshotKeys(input).flatMap((key) =>
    applicableTargets(key, declared).map((target) => {
      if (key.kind !== "plugin" && key.kind !== "bundle") {
        return probeArtifact(targets, key, target);
      }
      if (key.kind === "bundle") {
        const rendered = wouldByPair.get(pairId(key, target));
        const entry = winner.get(serializeCapabilityKey(key));
        const sourceId = entry?.sourceIds[0];
        const parsed = sourceId ? bundleMeta(targets.mirrorRoot(sourceId), key.name) : null;
        const managed = parsed ? managedNpxBundleMeta(parsed, target, targets) : null;
        if (rendered?.renderedHash && managed) {
          return probeManagedNpxBundle(managed) === "all-present"
            ? {
                key,
                target,
                existence: "present" as const,
                hash: rendered.renderedHash,
              }
            : { key, target, existence: "missing" as const, hash: null };
        }
        const tile = sourceId
          ? winningTileBundle(targets, sourceTiles, input.selection, key, sourceId, target)
          : null;
        if (rendered?.renderedHash && tile) {
          return tileInstalled(tile.installer, targets)
            ? { key, target, existence: "present" as const, hash: rendered.renderedHash }
            : { key, target, existence: "missing" as const, hash: null };
        }
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
    sourceTiles,
    sourceRegistryRevision: input.sourceRegistry.revision,
    mirrors,
    catalog: input.catalog,
    plugins,
    bundles,
    selection: input.selection,
    ledger: {
      revision: null,
      identity: identityForLedger(input.ledger),
      value: input.ledger,
    },
    deploymentState: input.deploymentState,
    wouldDeploy,
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
