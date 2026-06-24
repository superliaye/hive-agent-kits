// Resolve Mirror source paths for deployable capabilities. Skills/agents may sit
// under @-group folders; this flattens to leaf name → source dir/file. Used by
// the deploy engine to read source content the pure transforms consume.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { DeployError } from "../effect/errors.ts";

function readDirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// Walk a folder-marker kind (skills/agents), returning leaf name → source dir.
// Exported as the shared capability-locator so the content-hash producer
// (kit/content-sha.ts) and the deploy readers resolve the on-disk Mirror layout
// through ONE function — a layout change can't silently desync the merge hash
// from what deploy reads.
export function resolveFolderSources(kindDir: string, marker: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, leaf: string): void => {
    if (existsSync(join(dir, marker))) {
      out.set(leaf, dir);
      return;
    }
    for (const child of readDirSafe(dir)) {
      if (child.startsWith(".")) continue;
      const full = join(dir, child);
      try {
        if (statSync(full).isDirectory()) walk(full, child);
      } catch {
        /* skip */
      }
    }
  };
  for (const entry of readDirSafe(kindDir)) {
    if (entry.startsWith(".")) continue;
    const full = join(kindDir, entry);
    try {
      if (statSync(full).isDirectory()) walk(full, entry);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Per-Mirror folder-marker resolution (one winner Mirror per name, not a union).
// Cross-Source precedence is resolved upstream (the resolved selection carries the
// winning SourceId per name), so each deployed name reads from EXACTLY its winner's
// Mirror — never a first/last-mirror-wins union.
//
// STATELESS by design: a Mirror's bytes are mutated in place by Sync (stage→swap
// under a stable `~/.hive/kit/mirrors/<id>` path), so a process-lifetime cache keyed
// by mirrorRoot would serve a stale leaf→dir map after any re-sync — a freshly-synced
// skill reading as "source not found", a removed one pointing at a deleted dir. The
// walk is one shallow readdir per kind dir; callers that resolve many names from one
// Mirror in a single pass can hoist `resolveFolderSources` themselves (see the deploy
// engine), but the shared accessor never holds cross-operation state.

// The winner Mirror's source dir for a skill leaf name, or null when absent.
export function skillSourceDir(mirrorRoot: string, name: string): string | null {
  return (
    resolveFolderSources(join(mirrorRoot, "capabilities", "skills"), "SKILL.md").get(name) ?? null
  );
}

// The winner Mirror's source dir for an agent leaf name, or null when absent.
export function agentSourceDir(mirrorRoot: string, name: string): string | null {
  return (
    resolveFolderSources(join(mirrorRoot, "capabilities", "agents"), "AGENT.md").get(name) ?? null
  );
}

// The on-disk path of a single-file Capability (instruction/plugin/bundle) in one
// Mirror — the shared locator both the content-hash producer and the deploy
// readers use, so a layout change touches one place. Null arg-shapes (a leaf name
// with a path separator) can't occur: names are validated leaf names upstream.
export function capabilityFilePath(
  mirrorRoot: string,
  kind: "instruction" | "plugin" | "bundle",
  name: string,
): string {
  const layout = {
    instruction: { dir: "instructions", ext: ".instructions.md" },
    plugin: { dir: "plugins", ext: ".plugin.md" },
    bundle: { dir: "bundles", ext: ".bundle.md" },
  }[kind];
  return join(mirrorRoot, "capabilities", layout.dir, `${name}${layout.ext}`);
}

// Load reusable snippets (capabilities/snippets/*.md) into name → body, unioned
// across active Source mirrors. Snippets are NOT capabilities (a build-time
// include), so the catalog's CapabilityKey collision pass never covers them — a
// naive union would let one mirror's snippet silently clobber another's, changing
// rendered skill/agent bodies. So a same-named snippet provided by >1 mirror
// FAILS the deploy with a typed DeployError(collision) naming it; never a silent
// winner.
export function loadSnippets(mirrorRoots: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  const provider = new Map<string, string>();
  for (const root of mirrorRoots) {
    const dir = join(root, "capabilities", "snippets");
    for (const f of readDirSafe(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      const prior = provider.get(name);
      if (prior !== undefined && prior !== root) {
        throw new DeployError({
          reason: "collision",
          message: `snippet '${name}' is provided by more than one Source — un-deployable`,
          name,
        });
      }
      provider.set(name, root);
      map.set(name, readFileSync(join(dir, f), "utf8").trim());
    }
  }
  return map;
}

// Read SKILL.md frontmatter for disable-model-invocation (lenient).
export function skillDisablesModelInvocation(srcDir: string): boolean {
  const md = join(srcDir, "SKILL.md");
  if (!existsSync(md)) return false;
  const content = readFileSync(md, "utf8");
  if (!content.startsWith("---")) return false;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return false;
  // Cheap line scan — avoids a full YAML parse for one boolean.
  return /^\s*disable-model-invocation:\s*true\s*$/m.test(content.slice(3, end));
}

// Instruction source file content from the winner's Mirror
// (capabilities/instructions/<name>.instructions.md).
export function instructionBody(mirrorRoot: string, name: string): string | null {
  const p = capabilityFilePath(mirrorRoot, "instruction", name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

// Plugin frontmatter (marketplace_source / marketplace_name / plugin_name) from
// the winner's Mirror.
export function pluginMeta(
  mirrorRoot: string,
  name: string,
): { source: string; market: string; pluginName: string } | null {
  const p = capabilityFilePath(mirrorRoot, "plugin", name);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8");
  const fm = parseFlatFrontmatter(content);
  return {
    source: fm.marketplace_source ?? "",
    market: fm.marketplace_name ?? "",
    pluginName: fm.plugin_name ?? name,
  };
}

// Bundle frontmatter (installer kind, source, pinned_commit, package, requires).
export type BundleMeta = {
  name: string;
  installerKind: "setup-script" | "npx-skills";
  source: string;
  pinnedCommit: string;
  command: string;
  flags: string[];
  hostFlagMap: Record<string, string[]>;
  pkg: string;
  requires: string[];
};

export function bundleMeta(mirrorRoot: string, name: string): BundleMeta | null {
  const p = capabilityFilePath(mirrorRoot, "bundle", name);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8");
  // Bundles carry nested YAML (installer block); a full parse is warranted here.
  const fm = parseYamlFrontmatter(content);
  const installer = (fm.installer ?? {}) as Record<string, unknown>;
  const kind = typeof installer.kind === "string" ? installer.kind : "setup-script";
  return {
    name,
    installerKind: kind === "npx-skills" ? "npx-skills" : "setup-script",
    source: typeof fm.source === "string" ? fm.source : "",
    pinnedCommit: typeof fm.pinned_commit === "string" ? fm.pinned_commit : "",
    command: typeof installer.command === "string" ? installer.command : "",
    flags: Array.isArray(installer.flags)
      ? installer.flags.filter((x): x is string => typeof x === "string")
      : [],
    hostFlagMap: normalizeHostFlagMap(installer.host_flag_map),
    pkg: typeof installer.package === "string" ? installer.package : "",
    requires: Array.isArray(fm.requires)
      ? fm.requires.filter((x): x is string => typeof x === "string")
      : [],
  };
}

function normalizeHostFlagMap(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(val)) out[k] = val.filter((x): x is string => typeof x === "string");
    }
  }
  return out;
}

function parseFlatFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!content.startsWith("---")) return out;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = yamlParse(content.slice(3, end).trim());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
