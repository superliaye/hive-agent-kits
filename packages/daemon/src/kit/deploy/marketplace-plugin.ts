import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployTarget } from "@hive/contract";
import type { DeployTargets } from "../targets.ts";
import type { ExecRequest } from "./adapter.ts";

type MarketplacePluginId = {
  target: DeployTarget;
  marketplaceName: string;
  pluginName: string;
};

export type MarketplacePluginInstall = MarketplacePluginId & {
  marketplaceSource: string;
};

// Every step re-runs safely. Each CLI fetches the repository itself, so a run
// installs the marketplace's latest commit. Claude keeps an installed plugin as-is
// on `install`, so `update` is what refreshes it; Codex re-copies on every `add`.
export function marketplacePluginCommands(install: MarketplacePluginInstall): ExecRequest[] {
  const id = `${install.pluginName}@${install.marketplaceName}`;
  if (install.target === "claude") {
    return [
      { command: "claude", args: ["plugin", "marketplace", "add", install.marketplaceSource] },
      { command: "claude", args: ["plugin", "marketplace", "update", install.marketplaceName] },
      { command: "claude", args: ["plugin", "install", id, "--scope", "user"] },
      { command: "claude", args: ["plugin", "update", id] },
    ];
  }
  return [
    { command: "codex", args: ["plugin", "marketplace", "add", install.marketplaceSource] },
    { command: "codex", args: ["plugin", "marketplace", "upgrade", install.marketplaceName] },
    { command: "codex", args: ["plugin", "add", id] },
  ];
}

// The CLI's own uninstall, which leaves the marketplace registered.
export function marketplacePluginRemoveCommand(plugin: MarketplacePluginId): ExecRequest {
  const id = `${plugin.pluginName}@${plugin.marketplaceName}`;
  return plugin.target === "claude"
    ? { command: "claude", args: ["plugin", "uninstall", id, "--scope", "user"] }
    : { command: "codex", args: ["plugin", "remove", id] };
}

// Whether the target CLI records the plugin as installed: Claude in
// `plugins/installed_plugins.json`, Codex as a `[plugins."<id>"]` config table.
export function marketplacePluginInstalled(
  targets: Pick<DeployTargets, "claudeHome" | "codexHome">,
  install: MarketplacePluginId,
): boolean {
  const id = `${install.pluginName}@${install.marketplaceName}`;
  const path =
    install.target === "claude"
      ? join(targets.claudeHome(), "plugins", "installed_plugins.json")
      : join(targets.codexHome(), "config.toml");
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  return install.target === "claude"
    ? content.includes(JSON.stringify(id))
    : content.includes(`[plugins.${JSON.stringify(id)}]`);
}
