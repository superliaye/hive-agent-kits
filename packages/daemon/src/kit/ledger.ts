// Deployment Ledger (Plan A3) — the shared interop record at ~/.agent-kit/
// manifest.json (the EXACT agent-kit schema). Two-writer file (Hive + the
// agent-kit CLI), so writes are read-modify-merge and prune decisions re-read
// the on-disk ledger immediately before deciding — never from a stale snapshot.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { DeployTarget, DeployTargets } from "./targets.ts";

// agent-kit's exact manifest schema (lib/manifest.js buildManifest).
const NameEntry = z.object({ name: z.string() });
const BundleEntry = z.object({ name: z.string(), pin: z.string().nullable() });

export const LedgerSchema = z.object({
  kitVersion: z.string(),
  // `agents` = the deploy-target CLIs (["claude","codex"]), per the agent-kit
  // manifest's top-level `agents` host list — NOT the agent CAPABILITIES, which
  // live in `agentDefs` below. The two never collide in the manifest object;
  // this naming is the fixed upstream interop contract, kept verbatim.
  agents: z.array(z.string()),
  skills: z.array(NameEntry),
  agentDefs: z.array(NameEntry),
  instructions: z.array(NameEntry),
  plugins: z.array(NameEntry),
  bundles: z.array(BundleEntry),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export function emptyLedger(): Ledger {
  return {
    kitVersion: "",
    agents: [],
    skills: [],
    agentDefs: [],
    instructions: [],
    plugins: [],
    bundles: [],
  };
}

// Read the on-disk ledger, or null if absent. Throws nothing — a malformed
// ledger is treated as "no prior install" (returns null), matching agent-kit.
export function readLedger(targets: DeployTargets): Ledger | null {
  const p = targets.ledgerPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const result = LedgerSchema.safeParse(parsed);
    return result.success ? result.data : coerceLegacy(parsed);
  } catch {
    return null;
  }
}

// Tolerate an agent-kit ledger that omits a section (older writer): coerce a
// partial object into the full shape rather than rejecting it.
function coerceLegacy(raw: unknown): Ledger | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const names = (v: unknown): { name: string }[] =>
    Array.isArray(v)
      ? v
          .map((e) =>
            typeof e === "object" && e && typeof (e as { name?: unknown }).name === "string"
              ? { name: (e as { name: string }).name }
              : null,
          )
          .filter((e): e is { name: string } => e !== null)
      : [];
  return {
    kitVersion: typeof o.kitVersion === "string" ? o.kitVersion : "",
    agents: Array.isArray(o.agents)
      ? o.agents.filter((a): a is string => typeof a === "string")
      : [],
    skills: names(o.skills),
    agentDefs: names(o.agentDefs),
    instructions: names(o.instructions),
    plugins: names(o.plugins),
    bundles: Array.isArray(o.bundles)
      ? o.bundles
          .map((e) =>
            typeof e === "object" && e && typeof (e as { name?: unknown }).name === "string"
              ? {
                  name: (e as { name: string }).name,
                  pin:
                    typeof (e as { pin?: unknown }).pin === "string"
                      ? (e as { pin: string }).pin
                      : null,
                }
              : null,
          )
          .filter((e): e is { name: string; pin: string | null } => e !== null)
      : [],
  };
}

function writeAtomic(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

export type LedgerMergeInput = {
  kitVersion: string;
  targets: DeployTarget[];
  skills: string[];
  agents: string[];
  instructions: string[];
  plugins: string[];
  bundles: { name: string; pin: string | null }[];
};

// Read-modify-merge: re-read the on-disk ledger, fold in what THIS deploy
// landed, and write atomically. Names this deploy did not touch (e.g. a skill
// the CLI added concurrently) are preserved. `prunedSkills`/`prunedAgents` are
// the owned-but-deselected names to drop — caller computes them against a fresh
// read (see reconcilePrune). Returns the written ledger.
export function mergeLedger(
  targets: DeployTargets,
  input: LedgerMergeInput,
  prunedSkills: string[],
  prunedAgents: string[],
): Ledger {
  const current = readLedger(targets) ?? emptyLedger();
  const dropSkill = new Set(prunedSkills);
  const dropAgent = new Set(prunedAgents);

  const mergeNames = (existing: { name: string }[], add: string[], drop: Set<string>) => {
    const set = new Map<string, { name: string }>();
    for (const e of existing) if (!drop.has(e.name)) set.set(e.name, e);
    for (const n of add) set.set(n, { name: n });
    return [...set.values()];
  };

  const mergeBundles = (
    existing: { name: string; pin: string | null }[],
    add: { name: string; pin: string | null }[],
  ) => {
    const set = new Map<string, { name: string; pin: string | null }>();
    for (const e of existing) set.set(e.name, e);
    for (const b of add) set.set(b.name, b);
    return [...set.values()];
  };

  const next: Ledger = {
    kitVersion: input.kitVersion || current.kitVersion,
    agents: Array.from(new Set([...current.agents, ...input.targets])),
    skills: mergeNames(current.skills, input.skills, dropSkill),
    agentDefs: mergeNames(current.agentDefs, input.agents, dropAgent),
    // Instructions are whole-file ownership; merge by name (no prune — agent-kit
    // never prunes instructions and re-concat overwrites).
    instructions: mergeNames(current.instructions, input.instructions, new Set()),
    plugins: mergeNames(current.plugins, input.plugins, new Set()),
    bundles: mergeBundles(current.bundles, input.bundles),
  };
  writeAtomic(targets.ledgerPath(), next);
  return next;
}

// Compute owned-but-deselected names by RE-READING the on-disk ledger NOW (A3:
// never from a stale request-start snapshot). Returns names present in the fresh
// ledger but absent from the new selection — only these are Hive-owned + prunable.
//
// `priorOwned` is the snapshot of names this deploy is allowed to prune: the
// names Hive owned at request start (read BEFORE applying). A name the agent-kit
// CLI added concurrently is in the fresh on-disk ledger but NOT in `priorOwned`,
// so it is never pruned (the two-writer lost-update guard, A3). The fresh re-read
// then narrows to names that still exist on disk now, so we never try to prune a
// name an external writer already removed.
export function reconcilePrune(
  targets: DeployTargets,
  selectedSkills: string[],
  selectedAgents: string[],
  priorOwned: { skills: string[]; agents: string[] },
): { skills: string[]; agents: string[] } {
  const fresh = readLedger(targets) ?? emptyLedger();
  const freshSkills = new Set(fresh.skills.map((e) => e.name));
  const freshAgents = new Set(fresh.agentDefs.map((e) => e.name));
  const keepSkill = new Set(selectedSkills);
  const keepAgent = new Set(selectedAgents);
  return {
    // Prunable = was Hive-owned at request start ∩ still on disk ∩ now deselected.
    skills: priorOwned.skills.filter((n) => freshSkills.has(n) && !keepSkill.has(n)),
    agents: priorOwned.agents.filter((n) => freshAgents.has(n) && !keepAgent.has(n)),
  };
}

// Snapshot the names Hive owns right now (the pre-deploy basis for prune).
export function ownedNamesSnapshot(targets: DeployTargets): {
  skills: string[];
  agents: string[];
} {
  const ledger = readLedger(targets) ?? emptyLedger();
  return {
    skills: ledger.skills.map((e) => e.name),
    agents: ledger.agentDefs.map((e) => e.name),
  };
}
