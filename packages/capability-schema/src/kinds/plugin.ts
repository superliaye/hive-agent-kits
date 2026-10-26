// Plugin capability schema — a marketplace pointer (ADR-0025). A `.plugin.md`
// frontmatter names a Claude Code or Codex plugin to install from a marketplace;
// deploy passes `marketplace_source` verbatim to each CLI's `plugin marketplace add`
// and then installs `plugin_name@marketplace_name`. A LENIENT SUPERSET, strict only on the load-bearing
// coordinates: `description`, `marketplace_source`, `marketplace_name` are required
// and non-empty; `plugin_name` is optional (deploy defaults it to the filename
// leaf); unknown keys pass through. `marketplace_source` is a non-empty string
// with NO org/repo/URL regex — deploy forwards it as-is, and a regex would reject
// valid Sources. `targets` names the CLIs whose marketplace lists the plugin
// (default Claude only). Hive installs and uninstalls every pointer through each
// CLI (ADR-0032), whether sync generated it for a marketplace Source (ADR-0031)
// or a kit author wrote it.

import { z } from "zod";

export const PluginTarget = z.enum(["claude", "codex"]);
export type PluginTarget = z.infer<typeof PluginTarget>;

export const PluginFrontmatter = z
  .object({
    description: z.string().min(1),
    marketplace_source: z.string().min(1),
    marketplace_name: z.string().min(1),
    plugin_name: z.string().min(1).optional(),
    targets: z.array(PluginTarget).min(1).optional(),
  })
  .passthrough();
export type PluginFrontmatter = z.infer<typeof PluginFrontmatter>;
