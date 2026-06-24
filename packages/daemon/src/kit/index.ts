// Kit module — capability deploy-manager for my-agent-kits. Public barrel.
//
// Wire types are re-exported from @hive/contract (the SSOT); the daemon-internal
// audit emitter type stays local.

export type {
  CapabilityEntry,
  CapabilityKind,
  Catalog,
  DeployDiff,
  DeployResult,
  PresetSummary,
  Selection,
  SourceSyncStatus,
  SyncRunResult,
  SyncStatus,
  VerifyEntry,
  VerifyReport,
  VerifyStatus,
  VerifyTargetStatus,
} from "@hive/contract";
export { SelectionSchema } from "@hive/contract";
export { DeployError, SyncError } from "./effect/errors.ts";
export { type CreateKitOptions, Kit, KitLive, type KitSvc } from "./effect/kit-live.ts";
export { type DeployTarget, type DeployTargets, defaultDeployTargets } from "./targets.ts";
export type { DeployAuditEvents } from "./types.ts";
