import type { CapabilityKey } from "@hive/capability-schema";
import type { DeployTarget } from "@hive/contract";

const ALL_TARGETS: readonly DeployTarget[] = ["claude", "codex"];

export function applicableTargets(key: CapabilityKey): DeployTarget[] {
  return key.kind === "plugin" ? ["claude"] : [...ALL_TARGETS];
}

export function applicableTargetSet(key: CapabilityKey): ReadonlySet<DeployTarget> {
  return new Set(applicableTargets(key));
}
