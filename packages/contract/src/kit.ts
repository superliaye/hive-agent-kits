// Kit wire contract — the single source of truth for the kit (capability
// deploy-manager) types the daemon and UI exchange over HTTP. Zod schemas with
// `z.infer` for every shape crossing the boundary; unprefixed names. Imports
// only `zod` and the zero-dep `@hive/capability-schema` vocabulary SSOT — no
// daemon internals, so the UI's Vite bundle can pull this in without dragging
// Effect/Hono/vendor SDKs into the renderer.

import { CapabilityKind } from "@hive/capability-schema";
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

// A single catalog entry as surfaced to the UI. `group` is the @-namespace path
// (display only); `name` is the deployed leaf name. `deployable:false` means a
// within-kind leaf-name collision blocks it.
export const CapabilityEntry = z.object({
  kind: CapabilityKind,
  name: z.string(),
  description: z.string(),
  group: z.string(),
  deployable: z.boolean(),
  blockedReason: z.string().optional(),
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
// launch sync auto-applies the latest SHA, so a healthy check lands on
// `up_to_date`.
export const SyncStatusState = z.enum(["up_to_date", "check_failed", "rate_limited"]);
export type SyncStatusState = z.infer<typeof SyncStatusState>;

export const SyncStatus = z.object({
  state: SyncStatusState,
  // Current mirror SHA (null when no good mirror yet).
  sha: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  // Last sync error reason, when state is check_failed/rate_limited.
  errorReason: z.string().optional(),
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
