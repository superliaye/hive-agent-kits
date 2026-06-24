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
import { serializeCapabilityKey } from "@hive/capability-schema";
import type { CapabilityKind, Catalog, DeployDiff, DiffEntry, Selection } from "@hive/contract";
import { log } from "../lib/log.ts";
import { readSkillSource } from "./deploy/adapter.ts";
import {
  hashDeployedAgent,
  hashDeployedInstruction,
  hashDeployedSkill,
  hashSkillFiles,
  sha256,
} from "./deploy/artifact-hash.ts";
import {
  agentSourceDir,
  instructionBody,
  loadSnippets,
  skillDisablesModelInvocation,
  skillSourceDir,
} from "./deploy/sources.ts";
import { transformAgent, transformInstructions, transformSkill } from "./deploy/transforms.ts";
import { DeployError } from "./effect/errors.ts";
import { type Ledger, readLedger } from "./ledger.ts";
import type { DeployTarget, DeployTargets } from "./targets.ts";

// A resolved deploy item: the leaf name plus the WINNING Source's id (whose Mirror
// the Deploy reads). Self-describing — the anti-corruption seam (ADR-0023:85-86):
// Deploy never recomputes precedence or counts Sources.
export type ResolvedItem = { name: string; sourceId: string };

// Concrete per-kind resolved deploy plan, resolved from a Selection against the
// catalog. Each selected name carries its winner Source. Daemon-internal — not a
// wire type.
export type ResolvedSelection = {
  instructions: ResolvedItem[];
  skills: ResolvedItem[];
  agents: ResolvedItem[];
  plugins: ResolvedItem[];
  bundles: ResolvedItem[];
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

// Resolve a Selection against the AggregatedCatalog into a concrete per-kind
// resolved plan, attaching each selected name's WINNING Source. Throws
// DeployError(collision) when a selected name has catalog entries but NONE
// deployable (a single-Source malformed key). A cross-Source collision no longer
// throws — the winner resolves (ADR-0023:91). A selected name no Source provides
// is dropped from the deploy plan + traced (the diff's `removed` pass still prunes
// a stale ledger-owned phantom).
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

  // The winner index: ONLY the deployable entries, keyed by CapabilityKey. The
  // catalog now emits TWO entries for a collided key (one deployable, one
  // shadowed); indexing all entries by (kind,name) would let the shadow clobber
  // the winner. Filtering to deployable first maps each key to exactly one Source.
  const winnerIndex = new Map<string, string>(); // key -> winner sourceId
  // Every key that has ANY entry (deployable or not) — to distinguish a malformed
  // (entries-but-none-deployable) key from a phantom (no entry at all).
  const keyHasEntry = new Set<string>();
  for (const e of catalog.entries) {
    const key = serializeCapabilityKey({ kind: e.kind, name: e.name });
    keyHasEntry.add(key);
    if (e.deployable) {
      // sourceIds[0] is the winner Source under noUncheckedIndexedAccess
      // (string | undefined); the .min(1) schema makes undefined a
      // should-never-happen — treat it as the no-deployable-entry branch below.
      const winner = e.sourceIds[0];
      if (winner !== undefined) winnerIndex.set(key, winner);
    }
  }

  const resolveKind = (kind: CapabilityKind, names: string[]): ResolvedItem[] => {
    const out: ResolvedItem[] = [];
    for (const name of names) {
      const key = serializeCapabilityKey({ kind, name });
      const winner = winnerIndex.get(key);
      if (winner !== undefined) {
        out.push({ name, sourceId: winner });
        continue;
      }
      if (keyHasEntry.has(key)) {
        // Has entries but none deployable — a single-Source malformed key.
        throw new DeployError({
          reason: "collision",
          message: `'${name}' (${kind}) is un-deployable (malformed source)`,
          name,
        });
      }
      // No catalog entry at all — drop from the deploy/add plan + trace. The
      // diff's removed pass still surfaces a stale ledger-owned phantom.
      log().warn(
        { module: "kit/selection", kind, name },
        "selected capability not provided by any active Source; dropped from deploy plan",
      );
    }
    return out;
  };

  return {
    instructions: resolveKind("instruction", apply("instructions")),
    skills: resolveKind("skill", apply("skills")),
    agents: resolveKind("agent", apply("agents")),
    plugins: resolveKind("plugin", apply("plugins")),
    bundles: resolveKind("bundle", apply("bundles")),
    targets: Array.from(new Set(selection.targets)),
  };
}

// Hash the rendered content a deploy WOULD write for a skill/agent under `target`,
// reading from the WINNER's Mirror (the single resolved mirrorRoot for this name),
// so a same-name new-body change is detectable. Mirrors what the engine writes per
// target (incl. the Codex sidecar) so the hash is comparable to `deployedHash`.
// Returns null when the source isn't in the winner's Mirror.
function renderedNamedHash(
  mirrorRoot: string,
  snippets: Map<string, string>,
  kind: "skill" | "agent",
  name: string,
  target: DeployTarget,
): string | null {
  if (kind === "skill") {
    const src = skillSourceDir(mirrorRoot, name);
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
  const src = agentSourceDir(mirrorRoot, name);
  if (!src) return null;
  const raw = readFileSync(join(src, "AGENT.md"), "utf8");
  const rendered = transformAgent({ name, raw }, snippets);
  return sha256(target === "claude" ? rendered.claudeMd : rendered.codexToml);
}

// Hash the concatenated instruction whole-file a deploy WOULD write. Each
// instruction resolves to ITS OWN winner Mirror — two instructions in one
// selection may be won by different Sources, so a single shared mirrorRoot would
// hash the wrong bytes. Concatenation order is the resolved-array order
// (deterministic, identical to the deploy path).
function renderedInstructionHash(items: readonly ResolvedItem[], targets: DeployTargets): string {
  const bodies = items
    .map((item) => instructionBody(targets.mirrorRoot(item.sourceId), item.name))
    .filter((b): b is string => b !== null);
  return sha256(transformInstructions(bodies));
}

// The reference target for the content diff — claude when selected, else codex.
// `deployedHash` and `renderedHash` MUST use the same target so the hashes are
// comparable (a codex-only selection diffs against the codex homes, not claude).
function refTarget(deployTargets: DeployTarget[]): DeployTarget {
  return deployTargets.includes("claude") ? "claude" : "codex";
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

// Compute the Deploy Diff: added/removed by name, changed by content hash. Each
// selected name reads from ITS winner's Mirror (the resolved item's sourceId), so
// a "changed" verdict is honest under multi-Source precedence. `activeMirrorRoots`
// is used ONLY for snippet loading (snippets aren't Capabilities — no winner).
export function computeDiff(
  targets: DeployTargets,
  activeMirrorRoots: readonly string[],
  resolved: ResolvedSelection,
): DeployDiff {
  const ledger = readLedger(targets);
  const ownedSkills = new Set((ledger?.skills ?? []).map((e) => e.name));
  const ownedAgents = new Set((ledger?.agentDefs ?? []).map((e) => e.name));
  const ownedInstr = new Set((ledger?.instructions ?? []).map((e) => e.name));

  // Diff against the homes the deploy actually writes to: claude when selected,
  // else codex. deployedHash + renderedHash use the same target so they compare.
  const target = refTarget(resolved.targets);

  // Load snippets once up front (like runDeploy) so a cross-Source snippet
  // collision surfaces as a typed DeployError in the DIFF path too — the diff
  // preview must not say "ok" for a selection the deploy would reject.
  const snippets = loadSnippets(activeMirrorRoots);

  const entries: DiffEntry[] = [];

  const diffNamed = (
    kind: "skill" | "agent",
    selected: readonly ResolvedItem[],
    owned: Set<string>,
  ) => {
    const sel = new Set(selected.map((i) => i.name));
    // added / changed
    for (const item of selected) {
      if (!owned.has(item.name)) {
        entries.push({ kind, name: item.name, change: "added" });
      } else {
        const newHash = renderedNamedHash(
          targets.mirrorRoot(item.sourceId),
          snippets,
          kind,
          item.name,
          target,
        );
        const oldHash =
          kind === "skill"
            ? hashDeployedSkill(targets, item.name, target)
            : hashDeployedAgent(targets, item.name, target);
        if (newHash && oldHash && newHash !== oldHash) {
          entries.push({ kind, name: item.name, change: "changed" });
        }
      }
    }
    // removed (owned-but-deselected)
    for (const name of owned) {
      if (!sel.has(name)) entries.push({ kind, name, change: "removed" });
    }
  };

  // plugin / bundle: name-set diff only (no content hash — external-installer owned).
  const diffUnhashed = (
    kind: "plugin" | "bundle",
    selected: readonly ResolvedItem[],
    owned: Set<string>,
  ) => {
    const sel = new Set(selected.map((i) => i.name));
    for (const item of selected) {
      if (!owned.has(item.name)) entries.push({ kind, name: item.name, change: "added" });
    }
    for (const name of owned) {
      if (!sel.has(name)) entries.push({ kind, name, change: "removed" });
    }
  };

  diffNamed("skill", resolved.skills, ownedSkills);
  diffNamed("agent", resolved.agents, ownedAgents);
  diffUnhashed("plugin", resolved.plugins, new Set((ledger?.plugins ?? []).map((e) => e.name)));
  diffUnhashed("bundle", resolved.bundles, new Set((ledger?.bundles ?? []).map((e) => e.name)));

  // Instructions: whole-file overwrite. added/changed/removed by name, plus the
  // user-authored-replacement warning when a selected target's instruction file
  // (CLAUDE.md / AGENTS.md) exists but isn't Kit-owned.
  const userAuthored = overwritesUserInstructionFile(targets, ledger, resolved.targets);
  const selInstr = new Set(resolved.instructions.map((i) => i.name));
  for (const item of resolved.instructions) {
    if (!ownedInstr.has(item.name)) {
      entries.push({
        kind: "instruction",
        name: item.name,
        change: "added",
        ...(userAuthored ? { replacesUserFile: true } : {}),
      });
    }
  }
  for (const name of ownedInstr) {
    if (!selInstr.has(name)) entries.push({ kind: "instruction", name, change: "removed" });
  }
  // Content-changed instruction set (same names, different concatenated body).
  // Each instruction hashes against its OWN winner Mirror (split-winner safe).
  if (
    resolved.instructions.length > 0 &&
    [...selInstr].every((n) => ownedInstr.has(n)) &&
    ownedInstr.size > 0
  ) {
    const newHash = renderedInstructionHash(resolved.instructions, targets);
    const oldHash = hashDeployedInstruction(targets, target);
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
