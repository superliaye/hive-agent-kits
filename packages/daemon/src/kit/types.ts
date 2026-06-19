// Kit domain types + Zod boundary schemas.

import { z } from "zod";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { DeployTarget } from "./targets.ts";

// The five deployable capability kinds (upstream taxonomy). `snippet` is a
// build-time include, not a deploy kind.
export const CapabilityKind = z.enum(["instruction", "skill", "agent", "plugin", "bundle"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

// Mirror provenance recorded next to the synced tree.
export const MirrorProvenance = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-hex SHA"),
  fetchedAt: z.number().int(),
});
export type MirrorProvenance = z.infer<typeof MirrorProvenance>;

// A single catalog entry as surfaced to the UI. `group` is the @-namespace path
// (display only); `name` is the deployed leaf name. `deployable:false` means a
// within-kind leaf-name collision blocks it.
export type CapabilityEntry = {
  kind: CapabilityKind;
  name: string;
  description: string;
  group: string; // e.g. "@loop/@setup" — "" for top-level
  deployable: boolean;
  // Why undeployable (collision message), when deployable === false.
  blockedReason?: string;
};

// A preset (named selection seed) resolved from presets/*.yaml.
export type PresetSummary = {
  name: string;
  description: string;
  defaultAgents: DeployTarget[];
  capabilities: {
    instructions: string[];
    skills: string[];
    agents: string[];
    plugins: string[];
    bundles: string[];
  };
};

// A skipped/malformed entry, surfaced in status (resilient load).
export type CatalogProblem = {
  kind: string;
  name: string;
  problem: string;
};

export type Catalog = {
  entries: CapabilityEntry[];
  presets: PresetSummary[];
  problems: CatalogProblem[];
};

// Sync status surfaced by GET /api/kit/state. There is no `update_available`
// state: the launch sync auto-applies the latest SHA into the Mirror, so a
// healthy check always lands on `up_to_date`. (A check-only "newer available but
// not applied" mode would belong to the deferred background-polling feature.)
export type SyncStatusState = "up_to_date" | "check_failed" | "rate_limited";

export type SyncStatus = {
  state: SyncStatusState;
  // Current mirror SHA (null when no good mirror yet).
  sha: string | null;
  fetchedAt: number | null;
  // Last sync error reason, when state is check_failed/rate_limited.
  errorReason?: string;
  rateLimitReset?: number;
};

// ---- Selection (wire boundary) ----

export const SelectionSchema = z.object({
  presets: z.array(z.string()),
  // Individual toggles layered on the preset seed.
  add: z.object({
    instructions: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
    plugins: z.array(z.string()).default([]),
    bundles: z.array(z.string()).default([]),
  }),
  remove: z.object({
    instructions: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
    plugins: z.array(z.string()).default([]),
    bundles: z.array(z.string()).default([]),
  }),
  targets: z.array(z.enum(["claude", "codex"])).min(1),
});
export type Selection = z.infer<typeof SelectionSchema>;

// Concrete per-kind name set, resolved from a Selection against the catalog.
export type ResolvedSelection = {
  instructions: string[];
  skills: string[];
  agents: string[];
  plugins: string[];
  bundles: string[];
  targets: DeployTarget[];
};

// ---- Deploy Diff ----

export type DiffEntry = {
  kind: CapabilityKind;
  name: string;
  // `added` (new to disk/ledger), `removed` (owned-but-deselected),
  // `changed` (same name, different content hash vs Mirror).
  change: "added" | "removed" | "changed";
  // True when this entry would overwrite a non-Kit (user-authored) instruction
  // file — the CLAUDE.md-replacement warning.
  replacesUserFile?: boolean;
};

export type DeployDiff = {
  entries: DiffEntry[];
};

// ---- Deploy result (per-kind, ordered best-effort) ----

export type KindResult = {
  kind: CapabilityKind;
  applied: string[];
  failed: { name: string; error: string }[];
  // Plugins/bundles never auto-removed: a hint when one was deselected.
  pruneHint?: string[];
};

export type DeployResult = {
  kitSha: string | null;
  perKind: KindResult[];
  // Names pruned (owned-but-deselected skills/agents).
  pruned: { kind: CapabilityKind; name: string }[];
  targets: DeployTarget[];
};

// ---- Verify (on-disk existence + drift) ----

// Per-target on-disk status for a deployed capability:
//   present  — the expected file(s) exist and match the fingerprint (or no
//              fingerprint was recorded — a pre-existing deploy never false-alarms).
//   missing  — the ledger records it but the on-disk target is gone.
//   drifted  — present, but edited since deploy (disk hash ≠ recorded fingerprint).
//   recorded — plugin/bundle: external-installer owned, not stat-verifiable.
export type VerifyStatus = "present" | "missing" | "drifted" | "recorded";

// One (target → status) result for a capability under a single CLI target.
export type VerifyTargetStatus = {
  target: DeployTarget;
  status: VerifyStatus;
};

// A capability's per-target verify result. `targets` holds one entry per CLI the
// ledger targets (gated by ledger.agents) for stat-verifiable kinds; for
// plugin/bundle it is a single `recorded` entry (target-agnostic).
export type VerifyEntry = {
  kind: CapabilityKind;
  name: string;
  targets: VerifyTargetStatus[];
};

export type VerifyReport = {
  entries: VerifyEntry[];
};

// ---- Audit event (source: 'deploy') ----

export type DeployAuditEvents = {
  "deploy.applied": {
    kitSha: string | null;
    perKindCounts: Record<string, number>;
    targetClis: DeployTarget[];
  };
};

export type KitEventEmitter = TypedEmitter<DeployAuditEvents>;
