// Kit catalog reader (Plan A2) — the read model behind the UI + deploy resolution.
//
// Walk the Mirror's capabilities/<kind>/ structurally: a dir with SKILL.md /
// AGENT.md is a capability (leaf name); an @-group dir (no marker) recurses and
// flattens to the leaf. RESILIENT: one unparseable frontmatter or one cyclic
// preset is skipped-with-trace and surfaced in `problems` — the rest still
// loads. Within-kind leaf-name collisions mark colliding names un-deployable.
// Lenient frontmatter (display name/description only).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { log } from "../lib/log.ts";
import type { DeployTargets } from "./targets.ts";
import type {
  CapabilityEntry,
  CapabilityKind,
  Catalog,
  CatalogProblem,
  PresetSummary,
} from "./types.ts";

type RawEntry = {
  kind: CapabilityKind;
  name: string;
  description: string;
  group: string;
};

// Lenient frontmatter parse — never throws; returns {} on malformed input.
function parseFrontmatter(content: string): Record<string, unknown> {
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

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readDirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// Folder-marker kinds: a dir with the marker IS a capability; otherwise it's an
// @-group — recurse, accumulating the group path for display.
// `dir` is the candidate folder, `dirName` its own folder name, `groupPath` the
// chain of @-group ancestors ABOVE it (excluding `dirName`). A dir with the
// marker is a leaf capability (name = dirName, group = groupPath). A dir without
// is a grouping folder — its name extends the group path for its children.
function collectFolderEntries(
  dir: string,
  dirName: string,
  groupPath: string,
  kind: CapabilityKind,
  marker: string,
  out: RawEntry[],
  problems: CatalogProblem[],
): void {
  const markerFile = join(dir, marker);
  if (existsSync(markerFile)) {
    let fm: Record<string, unknown> = {};
    try {
      fm = parseFrontmatter(readFileSync(markerFile, "utf8"));
    } catch (err) {
      problems.push({ kind, name: dirName, problem: `unreadable ${marker}: ${String(err)}` });
      log().warn(
        { module: "kit/catalog", kind, name: dirName, err: String(err) },
        "skipped capability",
      );
      return;
    }
    out.push({ kind, name: dirName, description: asString(fm.description), group: groupPath });
    return;
  }
  // Grouping folder: its name extends the group path for its children.
  const childGroup = groupPath ? `${groupPath}/${dirName}` : dirName;
  for (const child of readDirSafe(dir)) {
    if (child.startsWith(".")) continue;
    const childFull = join(dir, child);
    let isDir = false;
    try {
      isDir = statSync(childFull).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    collectFolderEntries(childFull, child, childGroup, kind, marker, out, problems);
  }
}

// File-marker kinds (instruction/plugin/bundle): one file per capability.
function collectFileEntries(
  dir: string,
  suffix: string,
  kind: CapabilityKind,
  out: RawEntry[],
  problems: CatalogProblem[],
): void {
  for (const entry of readDirSafe(dir)) {
    if (entry.startsWith(".") || !entry.endsWith(suffix)) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const name = entry.slice(0, entry.length - suffix.length);
    let description = "";
    try {
      description = asString(parseFrontmatter(readFileSync(full, "utf8")).description);
    } catch (err) {
      problems.push({ kind, name, problem: `unreadable: ${String(err)}` });
      continue;
    }
    out.push({ kind, name, description, group: "" });
  }
}

// Resolve within-kind collisions: when ≥2 entries share (kind,name), all of them
// are marked un-deployable (a hard block downstream, never silent overwrite).
function withCollisions(raw: RawEntry[], problems: CatalogProblem[]): CapabilityEntry[] {
  const counts = new Map<string, number>();
  for (const e of raw) {
    const key = `${e.kind}:${e.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return raw.map((e) => {
    const key = `${e.kind}:${e.name}`;
    const collides = (counts.get(key) ?? 0) > 1;
    if (collides) {
      problems.push({
        kind: e.kind,
        name: e.name,
        problem: "within-kind leaf-name collision — un-deployable",
      });
    }
    return {
      kind: e.kind,
      name: e.name,
      description: e.description,
      group: e.group,
      deployable: !collides,
      ...(collides ? { blockedReason: "duplicate leaf name within kind" } : {}),
    };
  });
}

// ---- Presets ----

const CAP_TYPES = ["instructions", "skills", "agents", "plugins", "bundles"] as const;
const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type RawPreset = {
  name: string;
  description: string;
  default_agents: string[];
  extends?: string;
  capabilities: Record<string, string[]>;
};

function loadRawPreset(presetsDir: string, name: string): RawPreset | null {
  if (!PRESET_NAME_RE.test(name)) return null;
  const path = join(presetsDir, `${name}.yaml`);
  if (!existsSync(path)) return null;
  const parsed = yamlParse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return null;
  const caps: Record<string, string[]> = {};
  const rawCaps = (parsed.capabilities ?? {}) as Record<string, unknown>;
  for (const t of CAP_TYPES) {
    const arr = rawCaps[t];
    caps[t] = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  }
  return {
    name: asString(parsed.name) || name,
    description: asString(parsed.description),
    default_agents: Array.isArray(parsed.default_agents)
      ? parsed.default_agents.filter((x): x is string => typeof x === "string")
      : [],
    extends: typeof parsed.extends === "string" ? parsed.extends : undefined,
    capabilities: caps,
  };
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

// Resolve a preset's extends chain into a flat capability set. Cycle/missing
// parent → null (caller records a problem, skips this preset).
function resolvePreset(presetsDir: string, name: string, seen: Set<string>): PresetSummary | null {
  if (seen.has(name)) return null; // cycle
  const raw = loadRawPreset(presetsDir, name);
  if (!raw) return null;
  seen.add(name);

  let caps = raw.capabilities;
  if (raw.extends) {
    const parent = resolvePreset(presetsDir, raw.extends, seen);
    if (!parent) return null; // missing/cyclic parent
    caps = {};
    for (const t of CAP_TYPES) {
      caps[t] = uniq([...(parentCaps(parent)[t] ?? []), ...(raw.capabilities[t] ?? [])]);
    }
  }

  const targets = raw.default_agents
    .map((a) => (a === "claude" || a === "claude-code" ? "claude" : a === "codex" ? "codex" : null))
    .filter((a): a is "claude" | "codex" => a !== null);

  return {
    name: raw.name,
    description: raw.description,
    defaultAgents: uniq(targets) as PresetSummary["defaultAgents"],
    capabilities: {
      instructions: caps.instructions ?? [],
      skills: caps.skills ?? [],
      agents: caps.agents ?? [],
      plugins: caps.plugins ?? [],
      bundles: caps.bundles ?? [],
    },
  };
}

function parentCaps(p: PresetSummary): Record<string, string[]> {
  return {
    instructions: p.capabilities.instructions,
    skills: p.capabilities.skills,
    agents: p.capabilities.agents,
    plugins: p.capabilities.plugins,
    bundles: p.capabilities.bundles,
  };
}

// Read the full catalog from the Mirror. Never throws on a single malformed
// entry — collects problems and loads the rest.
export function readCatalog(targets: DeployTargets): Catalog {
  const mirror = targets.mirrorRoot();
  const capsDir = join(mirror, "capabilities");
  const problems: CatalogProblem[] = [];
  const raw: RawEntry[] = [];

  // Folder kinds.
  collectKindRoot(join(capsDir, "skills"), "skill", "SKILL.md", raw, problems, true);
  collectKindRoot(join(capsDir, "agents"), "agent", "AGENT.md", raw, problems, true);
  // File kinds.
  collectFileEntries(
    join(capsDir, "instructions"),
    ".instructions.md",
    "instruction",
    raw,
    problems,
  );
  collectFileEntries(join(capsDir, "plugins"), ".plugin.md", "plugin", raw, problems);
  collectFileEntries(join(capsDir, "bundles"), ".bundle.md", "bundle", raw, problems);

  const entries = withCollisions(raw, problems);

  // Presets.
  const presetsDir = join(mirror, "presets");
  const presets: PresetSummary[] = [];
  for (const file of readDirSafe(presetsDir)) {
    if (!file.endsWith(".yaml")) continue;
    const name = file.slice(0, -5);
    try {
      const resolved = resolvePreset(presetsDir, name, new Set());
      if (resolved) {
        presets.push(resolved);
      } else {
        problems.push({ kind: "preset", name, problem: "missing/cyclic extends or invalid shape" });
      }
    } catch (err) {
      problems.push({ kind: "preset", name, problem: String(err) });
    }
  }

  return { entries, presets, problems };
}

function collectKindRoot(
  kindDir: string,
  kind: CapabilityKind,
  marker: string,
  out: RawEntry[],
  problems: CatalogProblem[],
  _folder: boolean,
): void {
  for (const entry of readDirSafe(kindDir)) {
    if (entry.startsWith(".")) continue;
    const full = join(kindDir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    // Top-level entry: its own name is `entry`, no ancestor group yet.
    collectFolderEntries(full, entry, "", kind, marker, out, problems);
  }
}
