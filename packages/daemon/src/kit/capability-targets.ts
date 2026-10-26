import type { CapabilityKey } from "@hive/capability-schema";
import type { DeployTarget } from "@hive/contract";

const ALL_TARGETS: readonly DeployTarget[] = ["claude", "codex"];

// Declared targets per plugin name, read from each winning plugin pointer. A
// plugin lands only on the CLIs whose marketplace lists it, which is Source
// content, so only a reader holding the catalog can narrow a plugin.
export type PluginTargets = ReadonlyMap<string, { readonly targets: readonly DeployTarget[] }>;

// A bundle pointer may narrow its CLIs too, as a Codex-only Tile installer does.
export type DeclaredTargets = {
  readonly plugins: PluginTargets;
  readonly bundles: PluginTargets;
};

export function applicableTargets(key: CapabilityKey, declared: DeclaredTargets): DeployTarget[] {
  if (key.kind === "plugin") return [...(declared.plugins.get(key.name)?.targets ?? ["claude"])];
  if (key.kind === "bundle") return [...(declared.bundles.get(key.name)?.targets ?? ALL_TARGETS)];
  return [...ALL_TARGETS];
}
