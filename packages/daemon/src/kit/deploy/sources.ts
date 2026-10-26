// Resolve Mirror source paths for deployable capabilities. Skills/agents may sit
// under @-group folders; this flattens to leaf name → source dir/file. Used by
// Deploy to read source content the pure transforms consume.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { DeployError } from "../effect/errors.ts";
import { readMirrorRecord } from "../mirror.ts";
import { CAPABILITY_KIT_RECIPE_ID } from "../recipes/recipe.ts";
import type { DeployTarget } from "../targets.ts";
import { readSkillSource } from "./adapter.ts";
import { type SkillFile, transformSkill } from "./transforms.ts";

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
// Mirror in a single pass can hoist `resolveFolderSources` themselves, but the shared
// accessor never holds cross-operation state.

// The winner Mirror's source dir for a skill leaf name, or null when absent.
export function skillSourceDir(mirrorRoot: string, name: string): string | null {
  return (
    resolveFolderSources(join(mirrorRoot, "capabilities", "skills"), "SKILL.md").get(name) ?? null
  );
}

// The files Deploy writes for a skill under `target`, or null when the Mirror
// lacks it. A capability kit's skill renders by the kit contract (includes,
// maintainer-file drops, the Codex sidecar); a skill from any other Recipe
// deploys exactly as its upstream ships it. A Mirror without a record predates
// Recipes and so was a kit. Staging and the Overview's rendered hash both come
// here, so the plan and the staged bytes cannot disagree. Throws on an unknown
// include in a kit SKILL.md.
export function renderedSkillFiles(
  mirrorRoot: string,
  name: string,
  target: DeployTarget,
  snippets: Map<string, string>,
): SkillFile[] | null {
  const source = skillSourceDir(mirrorRoot, name);
  if (!source) return null;
  const files = readSkillSource(source);
  const recipe = readMirrorRecord(mirrorRoot)?.recipe.id ?? CAPABILITY_KIT_RECIPE_ID;
  if (recipe !== CAPABILITY_KIT_RECIPE_ID) return files;
  const rendered = transformSkill(
    { name, files, disableModelInvocation: skillDisablesModelInvocation(source) },
    snippets,
  );
  return rendered.sidecar && target === "codex"
    ? [...rendered.files, rendered.sidecar]
    : rendered.files;
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

export type PluginMeta = {
  source: string;
  market: string;
  pluginName: string;
  // The CLIs whose marketplace lists the plugin; Claude only when undeclared.
  targets: DeployTarget[];
};

// Plugin frontmatter from the winner's Mirror.
export function pluginMeta(mirrorRoot: string, name: string): PluginMeta | null {
  const p = capabilityFilePath(mirrorRoot, "plugin", name);
  if (!existsSync(p)) return null;
  const fm = parseYamlFrontmatter(readFileSync(p, "utf8"));
  const declared = Array.isArray(fm.targets)
    ? fm.targets.filter((x): x is DeployTarget => x === "claude" || x === "codex")
    : [];
  return {
    source: typeof fm.marketplace_source === "string" ? fm.marketplace_source : "",
    market: typeof fm.marketplace_name === "string" ? fm.marketplace_name : "",
    pluginName: typeof fm.plugin_name === "string" ? fm.plugin_name : name,
    targets: declared.length > 0 ? [...new Set(declared)] : ["claude"],
  };
}

// Bundle frontmatter (installer kind, package, skills, verify_paths).
export type BundleMeta = {
  name: string;
  installerKind: "setup-script" | "npx-skills";
  pkg: string;
  skills: string[];
  verifyPaths: Partial<Record<"claude" | "codex", string[]>>;
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
    pkg: typeof installer.package === "string" ? installer.package : "",
    skills: normalizeStringList(installer.skills),
    verifyPaths: normalizeVerifyPaths(fm.verify_paths),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0)),
  ].sort();
}

function normalizeVerifyPaths(value: unknown): Partial<Record<"claude" | "codex", string[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Partial<Record<"claude" | "codex", string[]>> = {};
  for (const target of ["claude", "codex"] as const) {
    const configured = source[target];
    const paths =
      typeof configured === "string"
        ? configured.length > 0
          ? [configured]
          : []
        : normalizeStringList(configured);
    if (paths.length > 0) result[target] = paths;
  }
  return result;
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
