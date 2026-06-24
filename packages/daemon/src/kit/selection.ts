// Selection + Deploy Diff (Plan A5).
//
// Resolve preset(s) + individual ± + target CLIs into a concrete per-kind name
// set; refuse colliding leaf names (un-deployable per the catalog). Compute the
// diff vs current on-disk/Ledger state: added/removed by name, CHANGED by
// content — hash the deployed artifact against the new Mirror content (the
// Ledger stores names/pins only, so a same-name-new-body skill can't be detected
// by name-set diffing).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityKind, Catalog, DeployDiff, DiffEntry, Selection } from "@hive/contract";
import { readSkillSource } from "./deploy/adapter.ts";
import {
  hashDeployedAgent,
  hashDeployedInstruction,
  hashDeployedSkill,
  hashSkillFiles,
  sha256,
} from "./deploy/artifact-hash.ts";
import {
  agentSources,
  instructionBody,
  loadSnippets,
  skillDisablesModelInvocation,
  skillSources,
} from "./deploy/sources.ts";
import { transformAgent, transformInstructions, transformSkill } from "./deploy/transforms.ts";
import { DeployError } from "./effect/errors.ts";
import { type Ledger, readLedger } from "./ledger.ts";
import type { DeployTarget, DeployTargets } from "./targets.ts";

// Concrete per-kind name set, resolved from a Selection against the catalog.
// Daemon-internal (the resolved deploy plan) — not a wire type.
export type ResolvedSelection = {
  instructions: string[];
  skills: string[];
  agents: string[];
  plugins: string[];
  bundles: string[];
  targets: DeployTarget[];
};

type CapList = {
  instructions: string[];
  skills: string[];
  agents: string[];
  plugins: string[];
  bundles: string[];
};

function emptyCaps(): CapList {
  return { instructions: [], skills: [], agents: [], plugins: [], bundles: [] };
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

// Resolve a Selection against the catalog into a concrete per-kind name set.
// Throws DeployError(collision) when any selected name is un-deployable.
export function resolveSelection(catalog: Catalog, selection: Selection): ResolvedSelection {
  const seed = emptyCaps();
  for (const presetName of selection.presets) {
    const preset = catalog.presets.find((p) => p.name === presetName);
    if (!preset) continue;
    seed.instructions.push(...preset.capabilities.instructions);
    seed.skills.push(...preset.capabilities.skills);
    seed.agents.push(...preset.capabilities.agents);
    seed.plugins.push(...preset.capabilities.plugins);
    seed.bundles.push(...preset.capabilities.bundles);
  }

  const apply = (kind: keyof CapList) => {
    const removed = new Set(selection.remove[kind]);
    return uniq([...seed[kind], ...selection.add[kind]]).filter((n) => !removed.has(n));
  };

  const resolved: ResolvedSelection = {
    instructions: apply("instructions"),
    skills: apply("skills"),
    agents: apply("agents"),
    plugins: apply("plugins"),
    bundles: apply("bundles"),
    targets: Array.from(new Set(selection.targets)),
  };

  // Refuse any selected name the catalog marked un-deployable (collision).
  const undeployable = new Map<string, string>();
  for (const e of catalog.entries) {
    if (!e.deployable) undeployable.set(`${e.kind}:${e.name}`, e.name);
  }
  const kinds: { kind: CapabilityKind; names: string[] }[] = [
    { kind: "instruction", names: resolved.instructions },
    { kind: "skill", names: resolved.skills },
    { kind: "agent", names: resolved.agents },
    { kind: "plugin", names: resolved.plugins },
    { kind: "bundle", names: resolved.bundles },
  ];
  for (const { kind, names } of kinds) {
    for (const n of names) {
      if (undeployable.has(`${kind}:${n}`)) {
        throw new DeployError({
          reason: "collision",
          message: `'${n}' (${kind}) is un-deployable: within-kind leaf-name collision`,
          name: n,
        });
      }
    }
  }
  return resolved;
}

// Hash the rendered content a deploy WOULD write for a name under `target`, so a
// same-name new-body change is detectable. Mirrors what the engine writes per
// target (incl. the Codex sidecar) so the hash is comparable to `deployedHash`.
// Returns null when the source isn't in the Mirror.
function renderedHash(
  mirrorRoots: readonly string[],
  snippets: Map<string, string>,
  kind: CapabilityKind,
  name: string,
  allInstructions: string[],
  target: DeployTarget,
): string | null {
  if (kind === "skill") {
    const src = skillSources(mirrorRoots).get(name);
    if (!src) return null;
    const out = transformSkill(
      {
        name,
        files: readSkillSource(src),
        disableModelInvocation: skillDisablesModelInvocation(src),
      },
      snippets,
    );
    // Codex also writes the manual-only sidecar; claude does not (matches engine).
    const written = out.sidecar && target === "codex" ? [...out.files, out.sidecar] : out.files;
    return hashSkillFiles(written);
  }
  if (kind === "agent") {
    const src = agentSources(mirrorRoots).get(name);
    if (!src) return null;
    const raw = readFileSync(join(src, "AGENT.md"), "utf8");
    const rendered = transformAgent({ name, raw }, snippets);
    return sha256(target === "claude" ? rendered.claudeMd : rendered.codexToml);
  }
  if (kind === "instruction") {
    const bodies = allInstructions
      .map((n) => instructionBody(mirrorRoots, n))
      .filter((b): b is string => b !== null);
    // Both targets write the identical concatenated body.
    return sha256(transformInstructions(bodies));
  }
  return null;
}

// The reference target for the content diff — claude when selected, else codex.
// `deployedHash` and `renderedHash` MUST use the same target so the hashes are
// comparable (a codex-only selection diffs against the codex homes, not claude).
function refTarget(deployTargets: DeployTarget[]): DeployTarget {
  return deployTargets.includes("claude") ? "claude" : "codex";
}

// Hash what is currently deployed on disk for a name under the reference target.
// Returns null when nothing is deployed there. Delegates to the shared
// artifact-hash util so the diff and the verify/fingerprint passes never compute
// two incompatible hashes for the same on-disk artifact.
function deployedHash(
  targets: DeployTargets,
  kind: CapabilityKind,
  name: string,
  target: DeployTarget,
): string | null {
  if (kind === "skill") return hashDeployedSkill(targets, name, target);
  if (kind === "agent") return hashDeployedAgent(targets, name, target);
  if (kind === "instruction") return hashDeployedInstruction(targets, target);
  return null;
}

// Would this deploy overwrite a user-authored (non-Kit) instruction file on ANY
// selected target? The file is non-Kit when the ledger records no instructions
// but the on-disk file exists. Checks CLAUDE.md (claude) and AGENTS.md (codex).
function overwritesUserInstructionFile(
  targets: DeployTargets,
  ledger: Ledger | null,
  deployTargets: DeployTarget[],
): boolean {
  const kitOwnsInstructions = Boolean(ledger && ledger.instructions.length > 0);
  if (kitOwnsInstructions) return false;
  const paths: string[] = [];
  if (deployTargets.includes("claude")) paths.push(join(targets.claudeHome(), "CLAUDE.md"));
  if (deployTargets.includes("codex")) paths.push(join(targets.codexHome(), "AGENTS.md"));
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      if (statSync(p).isFile()) return true;
    } catch {
      // unreadable — treat as not-a-user-file
    }
  }
  return false;
}

// Compute the Deploy Diff: added/removed by name, changed by content hash.
export function computeDiff(
  targets: DeployTargets,
  mirrorRoots: readonly string[],
  _catalog: Catalog,
  resolved: ResolvedSelection,
): DeployDiff {
  const ledger = readLedger(targets);
  const ownedSkills = new Set((ledger?.skills ?? []).map((e) => e.name));
  const ownedAgents = new Set((ledger?.agentDefs ?? []).map((e) => e.name));
  const ownedInstr = new Set((ledger?.instructions ?? []).map((e) => e.name));
  const ownedPlugins = new Set((ledger?.plugins ?? []).map((e) => e.name));
  const ownedBundles = new Set((ledger?.bundles ?? []).map((e) => e.name));

  // Diff against the homes the deploy actually writes to: claude when selected,
  // else codex. deployedHash + renderedHash use the same target so they compare.
  const target = refTarget(resolved.targets);

  // Load snippets once up front (like runDeploy) so a cross-Source snippet
  // collision surfaces as a typed DeployError in the DIFF path too — the diff
  // preview must not say "ok" for a selection the deploy would reject.
  const snippets = loadSnippets(mirrorRoots);

  const entries: DiffEntry[] = [];

  const diffNamed = (
    kind: CapabilityKind,
    selected: string[],
    owned: Set<string>,
    hashable: boolean,
  ) => {
    const sel = new Set(selected);
    // added / changed
    for (const name of selected) {
      if (!owned.has(name)) {
        entries.push({ kind, name, change: "added" });
      } else if (hashable) {
        const newHash = renderedHash(
          mirrorRoots,
          snippets,
          kind,
          name,
          resolved.instructions,
          target,
        );
        const oldHash = deployedHash(targets, kind, name, target);
        if (newHash && oldHash && newHash !== oldHash) {
          entries.push({ kind, name, change: "changed" });
        }
      }
    }
    // removed (owned-but-deselected)
    for (const name of owned) {
      if (!sel.has(name)) entries.push({ kind, name, change: "removed" });
    }
  };

  diffNamed("skill", resolved.skills, ownedSkills, true);
  diffNamed("agent", resolved.agents, ownedAgents, true);
  diffNamed("plugin", resolved.plugins, ownedPlugins, false);
  diffNamed("bundle", resolved.bundles, ownedBundles, false);

  // Instructions: whole-file overwrite. added/changed/removed by name, plus the
  // user-authored-replacement warning when a selected target's instruction file
  // (CLAUDE.md / AGENTS.md) exists but isn't Kit-owned.
  const userAuthored = overwritesUserInstructionFile(targets, ledger, resolved.targets);
  const selInstr = new Set(resolved.instructions);
  for (const name of resolved.instructions) {
    if (!ownedInstr.has(name)) {
      entries.push({
        kind: "instruction",
        name,
        change: "added",
        ...(userAuthored ? { replacesUserFile: true } : {}),
      });
    }
  }
  for (const name of ownedInstr) {
    if (!selInstr.has(name)) entries.push({ kind: "instruction", name, change: "removed" });
  }
  // Content-changed instruction set (same names, different concatenated body).
  if (
    resolved.instructions.length > 0 &&
    [...selInstr].every((n) => ownedInstr.has(n)) &&
    ownedInstr.size > 0
  ) {
    const newHash = renderedHash(
      mirrorRoots,
      snippets,
      "instruction",
      "",
      resolved.instructions,
      target,
    );
    const oldHash = deployedHash(targets, "instruction", "", target);
    if (newHash && oldHash && newHash !== oldHash) {
      entries.push({
        kind: "instruction",
        name: "(CLAUDE.md)",
        change: "changed",
        ...(userAuthored ? { replacesUserFile: true } : {}),
      });
    }
  }

  return { entries };
}
