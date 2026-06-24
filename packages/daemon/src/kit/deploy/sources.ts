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
function resolveFolderSources(kindDir: string, marker: string): Map<string, string> {
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

// Union the per-mirror leaf-name → source-dir maps across active Source mirrors.
// A name colliding across mirrors is refused upstream by the catalog's
// cross-Source CapabilityKey pass, so a name that reaches deploy has exactly one
// providing Mirror — the union is unambiguous for anything deployable.
export function skillSources(mirrorRoots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of mirrorRoots) {
    for (const [name, dir] of resolveFolderSources(
      join(root, "capabilities", "skills"),
      "SKILL.md",
    )) {
      out.set(name, dir);
    }
  }
  return out;
}

export function agentSources(mirrorRoots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of mirrorRoots) {
    for (const [name, dir] of resolveFolderSources(
      join(root, "capabilities", "agents"),
      "AGENT.md",
    )) {
      out.set(name, dir);
    }
  }
  return out;
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

// First mirror (in active-Source order) that provides a file under a kind dir.
// A cross-Source same-name collision is refused upstream by the catalog pass, so
// the first match is the only match for anything that reaches deploy.
function firstMirrorWith(mirrorRoots: readonly string[], ...relSegments: string[]): string | null {
  for (const root of mirrorRoots) {
    const p = join(root, ...relSegments);
    if (existsSync(p)) return p;
  }
  return null;
}

// Instruction source file content (capabilities/instructions/<name>.instructions.md).
export function instructionBody(mirrorRoots: readonly string[], name: string): string | null {
  const p = firstMirrorWith(mirrorRoots, "capabilities", "instructions", `${name}.instructions.md`);
  if (!p) return null;
  return readFileSync(p, "utf8");
}

// Plugin frontmatter (marketplace_source / marketplace_name / plugin_name).
export function pluginMeta(
  mirrorRoots: readonly string[],
  name: string,
): { source: string; market: string; pluginName: string } | null {
  const p = firstMirrorWith(mirrorRoots, "capabilities", "plugins", `${name}.plugin.md`);
  if (!p) return null;
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

export function bundleMeta(mirrorRoots: readonly string[], name: string): BundleMeta | null {
  const p = firstMirrorWith(mirrorRoots, "capabilities", "bundles", `${name}.bundle.md`);
  if (!p) return null;
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
