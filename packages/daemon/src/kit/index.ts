// Kit module — capability deploy-manager for my-agent-kits. Public barrel.

export { DeployError, SyncError } from "./effect/errors.ts";
export { type CreateKitOptions, Kit, KitLive, type KitSvc } from "./effect/kit-live.ts";
export { type DeployTarget, type DeployTargets, defaultDeployTargets } from "./targets.ts";
export type { DeployAuditEvents } from "./types.ts";
export {
  type CapabilityEntry,
  type CapabilityKind,
  type Catalog,
  type DeployDiff,
  type DeployResult,
  type PresetSummary,
  type Selection,
  SelectionSchema,
  type SyncStatus,
  type VerifyEntry,
  type VerifyReport,
  type VerifyStatus,
  type VerifyTargetStatus,
} from "./types.ts";
