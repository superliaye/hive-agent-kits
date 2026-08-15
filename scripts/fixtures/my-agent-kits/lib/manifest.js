// lib/manifest.js
// The install manifest: ~/.agent-kit/manifest.json — the durable, agent-neutral
// (Claude + Codex) record of what agent-kit owns on this machine. `init` owns the
// selection and writes it here; `update` replays it. Lives in HOME (durable
// state), NOT under the disposable bundle cache root (LOCALAPPDATA/.cache).
//
// Ownership contract: a name in the manifest is something agent-kit may manage
// (and may auto-remove when dropped/removed). Anything on disk but absent from
// the manifest is user-installed — agent-kit never touches it.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { withIndependentManifestLock } from "./manifest-lock.js";

function emptyManifest() {
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

export function manifestPath() {
  return join(homedir(), ".agent-kit", "manifest.json");
}

export async function withManifestLock(work, options = {}) {
  const p = manifestPath();
  mkdirSync(dirname(p), { recursive: true });
  return withIndependentManifestLock(p, work, options);
}

// Read the manifest, or null if absent/unparseable (treated as "no prior
// install" — callers decide what that means: init does a clean full deploy,
// update refuses).
export function readManifest() {
  const p = manifestPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  const p = manifestPath();
  mkdirSync(dirname(p), { recursive: true });
  const temporary = `${p}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { flush: true });
    renameSync(temporary, p);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function mergeSection(base = [], next = [], current = [], keyOf) {
  const baseByKey = new Map(base.map((entry) => [keyOf(entry), entry]));
  const nextByKey = new Map(next.map((entry) => [keyOf(entry), entry]));
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const deleted = new Set(
    [...baseByKey.keys()].filter((key) => !nextByKey.has(key) || !currentByKey.has(key)),
  );
  const orderedKeys = [...new Set([...nextByKey.keys(), ...currentByKey.keys()])];
  return orderedKeys.flatMap((key) => {
    if (deleted.has(key)) return [];
    const prior = baseByKey.get(key);
    const ours = nextByKey.get(key);
    const theirs = currentByKey.get(key);
    const oursChanged = ours !== undefined && JSON.stringify(ours) !== JSON.stringify(prior);
    const theirsChanged = theirs !== undefined && JSON.stringify(theirs) !== JSON.stringify(prior);
    const merged = oursChanged ? ours : theirsChanged ? theirs : (ours ?? theirs);
    return merged === undefined ? [] : [merged];
  });
}

export async function commitManifest(base, next) {
  return withManifestLock(() => {
    const prior = base ?? emptyManifest();
    const current = readManifest() ?? prior;
    const merged = {
      kitVersion: next.kitVersion !== prior.kitVersion ? next.kitVersion : current.kitVersion,
      agents: mergeSection(prior.agents, next.agents, current.agents, (entry) => entry),
      skills: mergeSection(prior.skills, next.skills, current.skills, (entry) => entry.name),
      agentDefs: mergeSection(prior.agentDefs, next.agentDefs, current.agentDefs, (entry) => entry.name),
      instructions: mergeSection(prior.instructions, next.instructions, current.instructions, (entry) => entry.name),
      plugins: mergeSection(prior.plugins, next.plugins, current.plugins, (entry) => entry.name),
      bundles: mergeSection(prior.bundles, next.bundles, current.bundles, (entry) => entry.name),
    };
    writeManifest(merged);
    return merged;
  });
}

// Construct the manifest object from a deploy's selection. Per-type shape:
//   skills/instructions/plugins → { name }
//   bundles                     → { name, pin }   (pin = the skip signal)
export function buildManifest({ kitVersion, agents, capabilities, bundlePins = {} }) {
  return {
    kitVersion,
    agents,
    skills:       (capabilities.skills ?? []).map((name) => ({ name })),
    // `agentDefs`, not `agents`: the top-level `agents` key above is the deploy
    // host list (claude/codex). The agent *capability* selection lives here, so
    // the two never collide in the manifest object.
    agentDefs:    (capabilities.agents ?? []).map((name) => ({ name })),
    instructions: (capabilities.instructions ?? []).map((name) => ({ name })),
    plugins:      (capabilities.plugins ?? []).map((name) => ({ name })),
    bundles:      (capabilities.bundles ?? []).map((name) => ({ name, pin: bundlePins[name] ?? null })),
  };
}

// Pull the name list out of a manifest section ([{name}, ...] → [name, ...]).
export function namesOf(section) {
  return (section ?? []).map((e) => e.name);
}

// Names present in `priorNames` but not in `newNames` — the orphans to reconcile.
export function orphanedNames(priorNames, newNames) {
  const keep = new Set(newNames);
  return priorNames.filter((n) => !keep.has(n));
}
