// Marketplace Source ingestion (ADR-0031). A git Source whose tree is a plugin
// marketplace — no `capabilities/`, but a Claude Code and/or Codex marketplace
// file at its root — is projected into the capability format at Sync: one
// `capabilities/plugins/<name>.plugin.md` pointer per listed plugin, written into
// the staged Mirror before it is committed. Catalog, Selection, and Deploy then
// treat it like any other plugin pointer.
//
// The pointer records the synced commit so its ContentSha moves with every new
// commit; that is what surfaces a pending update. Deploy still installs from the
// repository URL, so the CLIs fetch the plugin fresh rather than from the Mirror.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAME_PATTERN, type PluginTarget } from "@hive/capability-schema";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { log } from "../../lib/log.ts";

const ClaudeMarketplace = z.object({
  name: z.string().min(1),
  plugins: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
});

const CodexMarketplace = z.object({
  name: z.string().min(1),
  plugins: z.array(
    z.object({
      name: z.string().min(1),
      source: z.object({ path: z.string().min(1) }).optional(),
    }),
  ),
});

const CodexManifest = z.object({ description: z.string().optional() });

const CLAUDE_MARKETPLACE = join(".claude-plugin", "marketplace.json");
const CODEX_MARKETPLACE = join(".agents", "plugins", "marketplace.json");

type ListedPlugin = { targets: PluginTarget[]; description?: string };

function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function codexDescription(root: string, pluginPath: string | undefined): string | undefined {
  if (!pluginPath) return undefined;
  return readJson(join(root, pluginPath, ".codex-plugin", "plugin.json"), CodexManifest)
    ?.description;
}

// Writes a pointer per listed plugin into `root`. A tree that already carries
// `capabilities/` is a capability kit, never a marketplace, so it is left as-is.
export function materializeMarketplacePlugins(root: string, repoUrl: string, commit: string): void {
  if (existsSync(join(root, "capabilities"))) return;
  const claude = readJson(join(root, CLAUDE_MARKETPLACE), ClaudeMarketplace);
  const codex = readJson(join(root, CODEX_MARKETPLACE), CodexMarketplace);
  if (!claude && !codex) return;
  if (claude && codex && claude.name !== codex.name) {
    log().warn(
      { module: "kit/marketplace", claude: claude.name, codex: codex.name },
      "marketplace names differ between Claude and Codex files; no plugins ingested",
    );
    return;
  }
  const marketplaceName = claude?.name ?? codex?.name ?? "";

  const listed = new Map<string, ListedPlugin>();
  for (const plugin of claude?.plugins ?? []) {
    listed.set(plugin.name, { targets: ["claude"], description: plugin.description });
  }
  for (const plugin of codex?.plugins ?? []) {
    const entry = listed.get(plugin.name);
    if (entry) {
      entry.targets.push("codex");
      entry.description ??= codexDescription(root, plugin.source?.path);
    } else {
      listed.set(plugin.name, {
        targets: ["codex"],
        description: codexDescription(root, plugin.source?.path),
      });
    }
  }

  const pluginsDir = join(root, "capabilities", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  for (const [name, plugin] of listed) {
    if (!NAME_PATTERN.test(name)) {
      log().warn({ module: "kit/marketplace", plugin: name }, "invalid plugin name; skipped");
      continue;
    }
    const frontmatter = yamlStringify({
      description: plugin.description || name,
      marketplace_source: repoUrl,
      marketplace_name: marketplaceName,
      plugin_name: name,
      targets: plugin.targets,
      source_commit: commit,
    });
    writeFileSync(join(pluginsDir, `${name}.plugin.md`), `---\n${frontmatter}---\n`);
  }
}
