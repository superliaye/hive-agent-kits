// Plugin capability schema — a marketplace pointer (ADR-0025). A `.plugin.md`
// frontmatter names a Claude Code plugin to install from a marketplace; deploy
// passes `marketplace_source` verbatim to `claude plugin marketplace add` and then
// installs `marketplace_name`. A LENIENT SUPERSET, strict only on the load-bearing
// coordinates: `description`, `marketplace_source`, `marketplace_name` are required
// and non-empty; `plugin_name` is optional (deploy defaults it to the filename
// leaf); unknown keys pass through. `marketplace_source` is a non-empty string
// with NO org/repo/URL regex — deploy forwards it as-is, and a regex would reject
// valid Sources. Plugin is Claude-only at deploy, but that is a deploy fact, not a
// schema field — the frontmatter carries no target.

import { z } from "zod";

export const PluginFrontmatter = z
  .object({
    description: z.string().min(1),
    marketplace_source: z.string().min(1),
    marketplace_name: z.string().min(1),
    plugin_name: z.string().min(1).optional(),
  })
  .passthrough();
export type PluginFrontmatter = z.infer<typeof PluginFrontmatter>;
