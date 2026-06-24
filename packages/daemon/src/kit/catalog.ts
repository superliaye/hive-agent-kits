// Kit catalog reader (Plan A2) — the read model behind the UI + deploy resolution.
//
// A thin daemon adapter over @hive/capability-schema-tools: build a SourceTree
// rooted at the Mirror, run the tools' lenient `parse`, then TRANSLATE the
// format-native result (`resolvable`/`collisionReason`) into contract's deploy
// wire (`deployable`/`blockedReason`) — the anti-corruption seam. RESILIENT: a
// malformed entry or a cyclic preset is surfaced in `problems`, the rest loads.
// Preset resolution stays daemon-side (a selection-seed concept, not the format).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@hive/capability-schema-tools";
import { nodeFsSourceTree } from "@hive/capability-schema-tools/node";
import type { CapabilityEntry, Catalog, CatalogProblem, PresetSummary } from "@hive/contract";
import { parse as yamlParse } from "yaml";
import { log } from "../lib/log.ts";
import type { DeployTargets } from "./targets.ts";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
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

  // The capability bytes live under <mirror>/capabilities; the SourceTree's
  // kind dirs (skills/, agents/, instructions/, …) are relative to that root.
  const tree = nodeFsSourceTree(join(mirror, "capabilities"));
  const parsed = parse(tree);

  // Translate format-native → contract wire (anti-corruption seam): `resolvable`
  // → `deployable`, `collisionReason` → `blockedReason`.
  const entries: CapabilityEntry[] = parsed.capabilities.map((cap) => ({
    kind: cap.kind,
    name: cap.name,
    description: cap.description,
    group: cap.group,
    deployable: cap.resolvable,
    ...(cap.collisionReason ? { blockedReason: cap.collisionReason } : {}),
  }));

  // Parse problems first (preserving the existing array order: collect/collision
  // problems before the preset loop), then re-emit each as a trace — the pure
  // tools package can't write the daemon's diagnostic log.
  const problems: CatalogProblem[] = parsed.problems.map((p) => ({
    kind: p.kind,
    name: p.name,
    problem: p.problem,
  }));
  for (const p of problems) {
    log().warn(
      { module: "kit/catalog", kind: p.kind, name: p.name, problem: p.problem },
      "skipped capability",
    );
  }

  // Presets (daemon-owned selection-seed concept).
  const presetsDir = join(mirror, "presets");
  const presets: PresetSummary[] = [];
  for (const file of readdirSafe(presetsDir)) {
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

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
