// Kit wire enums + verify types — the UI's hand-mirror of the daemon kit wire
// shapes (packages/daemon/src/kit/types.ts). Split out of api.ts (which pulls in
// DOM globals via window.__hive) so the daemon's drift-guard test can import
// these shapes without dragging DOM lib into the daemon's DOM-less typecheck.
//
// Drift-guarded against the daemon types by
// packages/daemon/src/kit/__tests__/kit-wire-mirror.test.ts.

export type KitCapabilityKind = "instruction" | "skill" | "agent" | "plugin" | "bundle";
export type KitDeployTarget = "claude" | "codex";

export type KitVerifyStatus = "present" | "missing" | "drifted" | "recorded";

export type KitVerifyTargetStatus = {
  target: KitDeployTarget;
  status: KitVerifyStatus;
};

export type KitVerifyEntry = {
  kind: KitCapabilityKind;
  name: string;
  targets: KitVerifyTargetStatus[];
};

export type KitVerifyReport = { entries: KitVerifyEntry[] };
