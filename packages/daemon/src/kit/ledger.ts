// Deployment Ledger (Plan A3) — the shared interop record at ~/.agent-kit/
// manifest.json (the EXACT agent-kit schema). Two-writer file (Hive + the
// agent-kit CLI), so writes are read-modify-merge and prune decisions re-read
// the on-disk ledger immediately before deciding — never from a stale snapshot.

import { existsSync, readFileSync } from "node:fs";
import { type Ledger, LedgerSchema } from "@hive/contract";
import {
  type AtomicWriteOptions,
  atomicWriteFile,
  withAdvisoryFileLock,
} from "../lib/durable-file.ts";
import type { DeployTarget, DeployTargets } from "./targets.ts";

// The wire schema + type live in @hive/contract; re-exported so kit-internal
// modules keep importing the ledger shape from this module alongside its fs verbs.
export { type Ledger, LedgerSchema };

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

export type LedgerMergeInput = {
  kitVersion: string;
  targets: DeployTarget[];
  skills: string[];
  agents: string[];
  instructions: string[];
  plugins: string[];
  bundles: { name: string; pin: string | null }[];
};

export type LedgerWriteOptions = AtomicWriteOptions & {
  lockTimeoutMs?: number;
  beforeCommit?: (attempt: number) => void;
};

function readLedgerBytes(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function parseLedgerBytes(raw: string | null): Ledger {
  if (raw === null) return emptyLedger();
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = LedgerSchema.safeParse(value);
    return parsed.success ? parsed.data : (coerceLegacy(value) ?? emptyLedger());
  } catch {
    return emptyLedger();
  }
}

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
  prunedInstructions: string[] = [],
  options: LedgerWriteOptions = {},
): Ledger {
  const dropSkill = new Set(prunedSkills);
  const dropAgent = new Set(prunedAgents);
  const dropInstruction = new Set(prunedInstructions);

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

  const path = targets.ledgerPath();
  return withAdvisoryFileLock(path, options.lockTimeoutMs ?? 5_000, () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = readLedgerBytes(path);
      const current = parseLedgerBytes(before);
      const next: Ledger = {
        kitVersion: input.kitVersion || current.kitVersion,
        agents: Array.from(new Set([...current.agents, ...input.targets])),
        skills: mergeNames(current.skills, input.skills, dropSkill),
        agentDefs: mergeNames(current.agentDefs, input.agents, dropAgent),
        // Instructions remain the byte-compatible agent-kit name list. The accepted
        // plan may explicitly remove a contribution after its whole-file rewrite
        // succeeds, so only those factual removals are dropped.
        instructions: mergeNames(current.instructions, input.instructions, dropInstruction),
        plugins: mergeNames(current.plugins, input.plugins, new Set()),
        bundles: mergeBundles(current.bundles, input.bundles),
      };
      options.beforeCommit?.(attempt);
      if (readLedgerBytes(path) !== before) continue;
      atomicWriteFile(path, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), options);
      return next;
    }
    throw new Error("ledger_concurrent_update");
  });
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
//
// `activeNames` is the per-kind set of names the ACTIVE catalog currently provides
// (#47 data-loss guard): an owned-but-deselected name is prunable ONLY if it is
// still in the active catalog. An owned name absent from it is an ORPHAN — its
// Source isn't active — and is KEPT (never auto-unlinked), honoring ADR-0023's
// "disabling only hides" without putting Source attribution in the Ledger.
export function reconcilePrune(
  targets: DeployTargets,
  selectedSkills: string[],
  selectedAgents: string[],
  priorOwned: { skills: string[]; agents: string[] },
  activeNames: { skills: Set<string>; agents: Set<string> },
): { skills: string[]; agents: string[] } {
  const fresh = readLedger(targets) ?? emptyLedger();
  const freshSkills = new Set(fresh.skills.map((e) => e.name));
  const freshAgents = new Set(fresh.agentDefs.map((e) => e.name));
  const keepSkill = new Set(selectedSkills);
  const keepAgent = new Set(selectedAgents);
  return {
    // Prunable = was Hive-owned at request start ∩ still on disk ∩ now deselected ∩
    // still provided by an active Source (in the active catalog).
    skills: priorOwned.skills.filter(
      (n) => freshSkills.has(n) && !keepSkill.has(n) && activeNames.skills.has(n),
    ),
    agents: priorOwned.agents.filter(
      (n) => freshAgents.has(n) && !keepAgent.has(n) && activeNames.agents.has(n),
    ),
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
