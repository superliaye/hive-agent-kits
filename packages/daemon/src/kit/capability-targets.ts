import type { CapabilityKey } from "@hive/capability-schema";
import type { DeployTarget } from "@hive/contract";

const ALL_TARGETS: readonly DeployTarget[] = ["claude", "codex"];

// Declared targets per plugin name, read from each winning plugin pointer. A
// plugin lands only on the CLIs whose marketplace lists it, which is Source
// content, so only a reader holding the catalog can narrow a plugin.
export type PluginTargets = ReadonlyMap<string, { readonly targets: readonly DeployTarget[] }>;

export function applicableTargets(
  key: CapabilityKey,
  pluginTargets: PluginTargets,
): DeployTarget[] {
  if (key.kind !== "plugin") return [...ALL_TARGETS];
  return [...(pluginTargets.get(key.name)?.targets ?? ["claude"])];
}
