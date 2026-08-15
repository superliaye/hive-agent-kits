// Kit wire contract — the single source of truth for the kit (capability
// deploy-manager) types the daemon and UI exchange over HTTP. Zod schemas with
// `z.infer` for every shape crossing the boundary; unprefixed names. Imports
// only `zod` and the zero-dep `@hive/capability-schema` vocabulary SSOT — no
// daemon internals, so the UI's Vite bundle can pull this in without dragging
// Effect/Hono/vendor SDKs into the renderer.

import { CapabilityKey, CapabilityKind } from "@hive/capability-schema";
import { z } from "zod";

// The five deployable capability kinds (upstream taxonomy) — re-exported from the
// capability-format SSOT (also used below in the wire envelopes). `snippet` is a
// build-time include, not a deploy kind.
export { CapabilityKind };

// Per-CLI deploy target. The canonical enum — distinct from the AgentBackend
// wire enum (claude-code | codex), which is a separate domain. Routes to 3 home
// dirs daemon-side.
export const DeployTarget = z.enum(["claude", "codex"]);
export type DeployTarget = z.infer<typeof DeployTarget>;

// A single catalog entry (one content Variant of a CapabilityKey) as surfaced to
// the UI. `group` is the @-namespace path (display only); `name` is the deployed
// leaf name. Two entries may now share `(kind, name)` — distinct content Variants
// of one CapabilityKey — disambiguated by `contentSha`.
//
//   sourceIds  — the Source(s) providing THIS Variant (same ContentSha), ordered
//                winner-first (highest precedence at index 0). length > 1 = a Merge.
//                The `.min(1)` floor is a runtime guard ("every entry has ≥1
//                provider") that TS can't narrow from the tuple.
//   contentSha — the Variant's content identity; its stable wire identity now that
//                `(kind, name)` is no longer unique.
//   shadowed   — true = this Variant lost precedence to a sibling Variant under the
//                same CapabilityKey (a non-blocking duplicate, "not deployed
//                (duplicate)"). Distinct from `blockedReason` (malformed/un-deployable).
//   shadowedBy — on a shadowed Variant, the winning (deployable) Variant's
//                top-provider sourceId — so the UI can name "Hidden — also provided
//                by <Source>". Undefined on the winner and on non-shadowed entries.
//
// Exactly one Variant per CapabilityKey is `deployable:true`; shadowed and blocked
// Variants are `deployable:false`.
export const CapabilityEntry = z.object({
  kind: CapabilityKind,
  name: z.string(),
  description: z.string(),
  group: z.string(),
  deployable: z.boolean(),
  shadowed: z.boolean(),
  sourceIds: z.array(z.string()).min(1),
  contentSha: z.string(),
  blockedReason: z.string().optional(),
  shadowedBy: z.string().optional(),
});
export type CapabilityEntry = z.infer<typeof CapabilityEntry>;

// A preset (named selection seed) resolved from presets/*.yaml.
export const PresetSummary = z.object({
  name: z.string(),
  description: z.string(),
  defaultAgents: z.array(DeployTarget),
  capabilities: z.object({
    instructions: z.array(z.string()),
    skills: z.array(z.string()),
    agents: z.array(z.string()),
    plugins: z.array(z.string()),
    bundles: z.array(z.string()),
  }),
});
export type PresetSummary = z.infer<typeof PresetSummary>;

// A skipped/malformed entry, surfaced in status (resilient load).
export const CatalogProblem = z.object({
  kind: z.string(),
  name: z.string(),
  problem: z.string(),
});
export type CatalogProblem = z.infer<typeof CatalogProblem>;

export const Catalog = z.object({
  entries: z.array(CapabilityEntry),
  presets: z.array(PresetSummary),
  problems: z.array(CatalogProblem),
});
export type Catalog = z.infer<typeof Catalog>;

// Sync status surfaced by GET /api/kit/state. No `update_available` state: the
// launch sync auto-applies the latest SHA, so a healthy git check lands on
// `up_to_date`. `local` is the bundled Starter Source: copied from the in-repo
// package, never fetched — it has no SHA/fetchedAt and is never a network state.
export const SyncStatusState = z.enum(["up_to_date", "check_failed", "rate_limited", "local"]);
export type SyncStatusState = z.infer<typeof SyncStatusState>;

export const SyncStatus = z.object({
  state: SyncStatusState,
  // Current mirror SHA (null when no good mirror yet).
  sha: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  // Last sync error reason, when state is check_failed/rate_limited.
  errorReason: z.string().optional(),
  errorDetail: z.string().max(160).optional(),
  rateLimitReset: z.number().optional(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

// Per-Source freshness: a `SyncStatus` tagged with the Source it describes.
// `KitState.sync` is an array of these — one failed Source must not collapse
// another's freshness (each active Source syncs into its own Mirror).
export const SourceSyncStatus = SyncStatus.extend({
  sourceId: z.string(),
  origin: z.string(),
});
export type SourceSyncStatus = z.infer<typeof SourceSyncStatus>;

// POST /api/kit/sync response: the per-Source outcome of one sync run.
export const SyncRunResult = z.object({
  sources: z.array(
    z.object({
      sourceId: z.string(),
      origin: z.string(),
      status: z.enum(["synced", "unchanged", "failed"]),
      errorReason: z.string().optional(),
      errorDetail: z.string().max(160).optional(),
      rateLimitReset: z.number().optional(),
    }),
  ),
});
export type SyncRunResult = z.infer<typeof SyncRunResult>;

// ---- Selection (wire boundary) ----

const NameSets = z.object({
  instructions: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  bundles: z.array(z.string()).default([]),
});

export const SelectionSchema = z.object({
  presets: z.array(z.string()),
  // Individual toggles layered on the preset seed.
  add: NameSets,
  remove: NameSets,
  targets: z.array(DeployTarget).min(1),
});
export type Selection = z.infer<typeof SelectionSchema>;

// Durable desired state. Unlike the legacy SelectionSchema above, this retains
// resolved deploy identities and their exact target sets only: a Source and a
// ContentSha are deliberately not part of desired state.
export const DesiredSelection = z.object({
  enabled: z.array(z.object({ key: CapabilityKey, targets: z.array(DeployTarget).min(1) })),
  removalIntents: z.array(
    z.object({
      key: CapabilityKey,
      targets: z.array(DeployTarget).min(1),
      generation: z.string().min(1).optional(),
    }),
  ),
});
export type DesiredSelection = z.infer<typeof DesiredSelection>;

export const SelectionMutation = z.object({
  expectedRevision: z.number().int().nonnegative(),
  changes: z.array(
    z.object({
      key: CapabilityKey,
      enabled: z.boolean(),
      targets: z.array(DeployTarget).min(1),
    }),
  ),
});
export type SelectionMutation = z.infer<typeof SelectionMutation>;

export const SelectionSnapshot = DesiredSelection.extend({
  revision: z.number().int().nonnegative(),
});
export type SelectionSnapshot = z.infer<typeof SelectionSnapshot>;

// ---- Deployment Ledger ----

// agent-kit's exact manifest schema (lib/manifest.js buildManifest). The pure
// `z.object`; the daemon's fs read/merge logic re-imports this.
const NameEntry = z.object({ name: z.string() });
const BundleEntry = z.object({ name: z.string(), pin: z.string().nullable() });

export const LedgerSchema = z.object({
  kitVersion: z.string(),
  // `agents` = the deploy-target CLIs (["claude","codex"]) per the agent-kit
  // manifest's top-level `agents` host list — NOT agent CAPABILITIES (those are
  // `agentDefs`). The fixed upstream interop contract, kept verbatim.
  agents: z.array(z.string()),
  skills: z.array(NameEntry),
  agentDefs: z.array(NameEntry),
  instructions: z.array(NameEntry),
  plugins: z.array(NameEntry),
  bundles: z.array(BundleEntry),
});
export type Ledger = z.infer<typeof LedgerSchema>;

// Kit state surfaced by GET /api/kit/state: sync freshness + the ledger.
export const KitStateSchema = z.object({
  sync: z.array(SourceSyncStatus),
  ledger: LedgerSchema.nullable(),
});
export type KitState = z.infer<typeof KitStateSchema>;

// ---- Deploy Diff ----

export const DiffEntry = z.object({
  kind: CapabilityKind,
  name: z.string(),
  // `added` (new to disk/ledger), `removed` (owned-but-deselected),
  // `changed` (same name, different content hash vs Mirror).
  change: z.enum(["added", "removed", "changed"]),
  // True when this entry would overwrite a non-Kit (user-authored) instruction
  // file — the CLAUDE.md-replacement warning.
  replacesUserFile: z.boolean().optional(),
});
export type DiffEntry = z.infer<typeof DiffEntry>;

export const DeployDiff = z.object({
  entries: z.array(DiffEntry),
});
export type DeployDiff = z.infer<typeof DeployDiff>;

// ---- Deploy result (per-kind, ordered best-effort) ----

export const KindResult = z.object({
  kind: CapabilityKind,
  applied: z.array(z.string()),
  failed: z.array(z.object({ name: z.string(), error: z.string() })),
  // Plugins/bundles never auto-removed: a hint when one was deselected.
  pruneHint: z.array(z.string()).optional(),
});
export type KindResult = z.infer<typeof KindResult>;

export const DeployResult = z.object({
  kitSha: z.string().nullable(),
  perKind: z.array(KindResult),
  // Names pruned (owned-but-deselected skills/agents).
  pruned: z.array(z.object({ kind: CapabilityKind, name: z.string() })),
  targets: z.array(DeployTarget),
});
export type DeployResult = z.infer<typeof DeployResult>;

// ---- Verify (on-disk existence + drift) ----

// Per-target on-disk status for a deployed capability:
//   present  — expected file(s) exist and match the fingerprint (or none recorded).
//   missing  — the ledger records it but the on-disk target is gone.
//   drifted  — present, but edited since deploy (disk hash != recorded fingerprint).
//   recorded — plugin/bundle: external-installer owned, not stat-verifiable.
export const VerifyStatus = z.enum(["present", "missing", "drifted", "recorded"]);
export type VerifyStatus = z.infer<typeof VerifyStatus>;

export const VerifyTargetStatus = z.object({
  target: DeployTarget,
  status: VerifyStatus,
});
export type VerifyTargetStatus = z.infer<typeof VerifyTargetStatus>;

export const VerifyEntry = z.object({
  kind: CapabilityKind,
  name: z.string(),
  targets: z.array(VerifyTargetStatus),
});
export type VerifyEntry = z.infer<typeof VerifyEntry>;

export const VerifyReport = z.object({
  entries: z.array(VerifyEntry),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

// ---- Authoritative Deployment Overview ----

export const OverviewCatalogState = z.enum([
  "deployable",
  "shadowed",
  "blocked",
  "unavailable",
]);
export type OverviewCatalogState = z.infer<typeof OverviewCatalogState>;

export const OverviewDesiredState = z.enum(["on", "off"]);
export type OverviewDesiredState = z.infer<typeof OverviewDesiredState>;

export const ReconciliationState = z.enum([
  "in_sync",
  "pending_add",
  "pending_update",
  "pending_remove",
  "waiting_for_source",
  "orphaned",
  "unmanaged_owned",
  "manual_removal_required",
]);
export type ReconciliationState = z.infer<typeof ReconciliationState>;

export const TargetObservation = z.enum([
  "verified",
  "present_unverified",
  "missing",
  "drifted",
  "recorded_unverified",
  "verification_error",
]);
export type TargetObservation = z.infer<typeof TargetObservation>;

export const OverviewLastAttempt = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({
    state: z.literal("succeeded"),
    operationId: z.string(),
    attemptedAt: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal("failed"),
    operationId: z.string(),
    attemptedAt: z.number().int().nonnegative(),
    code: z.string().max(80),
    detail: z.string().max(512).optional(),
  }),
]);
export type OverviewLastAttempt = z.infer<typeof OverviewLastAttempt>;

export const OverviewTargetState = z.object({
  target: DeployTarget,
  desired: OverviewDesiredState,
  reconciliation: ReconciliationState,
  observation: TargetObservation,
  lastAttempt: OverviewLastAttempt,
});
export type OverviewTargetState = z.infer<typeof OverviewTargetState>;

export const OverviewVariant = CapabilityEntry.extend({
  catalog: z.enum(["deployable", "shadowed", "blocked"]),
});
export type OverviewVariant = z.infer<typeof OverviewVariant>;

export const OverviewRow = z.object({
  key: CapabilityKey,
  catalog: OverviewCatalogState,
  desired: OverviewDesiredState,
  reconciliation: ReconciliationState,
  lastAttempt: OverviewLastAttempt,
  applicableTargets: z.array(DeployTarget),
  targets: z.array(OverviewTargetState),
  variants: z.array(OverviewVariant),
});
export type OverviewRow = z.infer<typeof OverviewRow>;

// Deliberately omits Source locators/origins: working-tree locators contain raw
// Daemon paths, which never belong in the Overview or plan diagnostics.
export const OverviewSource = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["git", "local"]),
  active: z.boolean(),
  rank: z.number().int(),
});
export type OverviewSource = z.infer<typeof OverviewSource>;

export const OverviewMirror = z.object({
  sourceId: z.string(),
  precedence: z.number().int(),
  identity: z.string().nullable(),
  error: z.enum(["unavailable"]).optional(),
});
export type OverviewMirror = z.infer<typeof OverviewMirror>;

export const DeployOperationState = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);
export type DeployOperationState = z.infer<typeof DeployOperationState>;

export const DeployOperationSummary = z.object({
  operationId: z.string(),
  state: DeployOperationState,
  acceptedAt: z.number().int().nonnegative(),
  selectionRevision: z.number().int().nonnegative(),
  planToken: z.string().regex(/^[0-9a-f]{64}$/).or(z.string().min(1)),
  completedAt: z.number().int().nonnegative().optional(),
});
export type DeployOperationSummary = z.infer<typeof DeployOperationSummary>;

export const DeploymentOverview = z.object({
  sources: z.array(OverviewSource),
  sourceRegistryRevision: z.number().int().nonnegative(),
  mirrors: z.array(OverviewMirror),
  selectionRevision: z.number().int().nonnegative(),
  variants: z.array(CapabilityEntry),
  rows: z.array(OverviewRow),
  diff: DeployDiff,
  planToken: z.string().regex(/^[0-9a-f]{64}$/),
  activeOperation: DeployOperationSummary.nullable(),
  lastOperation: DeployOperationSummary.nullable(),
});
export type DeploymentOverview = z.infer<typeof DeploymentOverview>;

export const AcceptedDeployRequest = z.object({
  selectionRevision: z.number().int().nonnegative(),
  planToken: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type AcceptedDeployRequest = z.infer<typeof AcceptedDeployRequest>;

export const AcceptedDeployResponse = z.object({ operationId: z.string().min(1) }).strict();
export type AcceptedDeployResponse = z.infer<typeof AcceptedDeployResponse>;
