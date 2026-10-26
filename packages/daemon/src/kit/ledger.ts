// Deployment Ledger — the shared interop record at ~/.agent-kit/
// manifest.json (the EXACT agent-kit schema). Two-writer file (Hive + the
// agent-kit CLI), so writes are read-modify-merge and prune decisions re-read
// the on-disk ledger immediately before deciding — never from a stale snapshot.

import { existsSync, readFileSync } from "node:fs";
import { type Ledger, LedgerSchema } from "@hive/contract";
import {
  type AtomicWriteOptions,
  atomicWriteFile,
  withCooperativeFileLock,
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
  prunedPlugins?: string[];
  prunedBundles?: string[];
};

export type LedgerWriteOptions = AtomicWriteOptions & {
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockUpdateMs?: number;
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
// read. Returns the written ledger.
export function mergeLedger(
  targets: DeployTargets,
  input: LedgerMergeInput,
  prunedSkills: string[],
  prunedAgents: string[],
  prunedInstructions: string[] = [],
  options: LedgerWriteOptions = {},
): Ledger {
  const path = targets.ledgerPath();
  return withCooperativeFileLock(
    path,
    options.lockTimeoutMs ?? 5_000,
    () =>
      mergeLedgerWithinLock(
        targets,
        input,
        prunedSkills,
        prunedAgents,
        prunedInstructions,
        options,
      ),
    { staleMs: options.lockStaleMs, updateMs: options.lockUpdateMs },
  );
}

export function mergeLedgerWithinLock(
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
  const dropPlugin = new Set(input.prunedPlugins ?? []);
  const dropBundle = new Set(input.prunedBundles ?? []);

  const mergeNames = (existing: { name: string }[], add: string[], drop: Set<string>) => {
    const set = new Map<string, { name: string }>();
    for (const e of existing) if (!drop.has(e.name)) set.set(e.name, e);
    for (const n of add) set.set(n, { name: n });
    return [...set.values()];
  };

  const mergeBundles = (
    existing: { name: string; pin: string | null }[],
    add: { name: string; pin: string | null }[],
    drop: Set<string>,
  ) => {
    const set = new Map<string, { name: string; pin: string | null }>();
    for (const e of existing) if (!drop.has(e.name)) set.set(e.name, e);
    for (const b of add) set.set(b.name, b);
    return [...set.values()];
  };

  const path = targets.ledgerPath();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = readLedgerBytes(path);
    const current = parseLedgerBytes(before);
    const next: Ledger = {
      kitVersion: input.kitVersion || current.kitVersion,
      agents: Array.from(new Set([...current.agents, ...input.targets])),
      skills: mergeNames(current.skills, input.skills, dropSkill),
      agentDefs: mergeNames(current.agentDefs, input.agents, dropAgent),
      instructions: mergeNames(current.instructions, input.instructions, dropInstruction),
      plugins: mergeNames(current.plugins, input.plugins, dropPlugin),
      bundles: mergeBundles(current.bundles, input.bundles, dropBundle),
    };
    options.beforeCommit?.(attempt);
    if (readLedgerBytes(path) !== before) continue;
    atomicWriteFile(path, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), options);
    return next;
  }
  throw new Error("ledger_concurrent_update");
}
