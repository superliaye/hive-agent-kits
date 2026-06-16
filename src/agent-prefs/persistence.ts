// Disk I/O for the agent model-preferences module.
//
// On-disk format: a single JSON file at `~/.hive/agent-model-prefs.json`
// (see types.ts). Writes are atomic via tmp-file + rename so a mid-write
// crash cannot corrupt the file. Unlike secrets.json these values are not
// sensitive (just model ids), so no 0600 narrowing.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AGENT_PREFS_FILE_VERSION, type AgentPrefsFile, AgentPrefsFileSchema } from "./types.ts";

const EMPTY: AgentPrefsFile = { version: AGENT_PREFS_FILE_VERSION, prefs: {} };

// The retired in-process backend (ADR-0019 deleted `native`). Files written by
// the prior ADR-0018 effort carry `backend: "native"`, which the current
// AgentBackend enum no longer admits. Tolerate-and-drop on read: a legacy
// `native` is treated as "no explicit backend pref" so resolution falls through
// to the harness/default backend — matching the threads read path, which
// already drops an unparseable stored backend (executor `backendOrUndefined`).
const RETIRED_BACKEND = "native";

// A permissive pre-parse: capture only `prefs[*].backend` as a free string so we
// can strip the retired value BEFORE the strict AgentPrefsFileSchema runs. Any
// other shape violation still surfaces from the strict parse below.
const LegacyEnvelopeSchema = z.object({
  prefs: z.record(z.string(), z.object({ backend: z.string() }).passthrough()).optional(),
});

/**
 * Drop any `backend: "native"` field from the parsed JSON so the retired value
 * never reaches the strict schema. Returns the input untouched when there is no
 * legacy backend to strip (the common case). Pure — does not mutate `json`.
 */
function dropRetiredBackend(json: unknown): unknown {
  const envelope = LegacyEnvelopeSchema.safeParse(json);
  if (!envelope.success || envelope.data.prefs === undefined) return json;

  const hasRetired = Object.values(envelope.data.prefs).some(
    (pref) => pref.backend === RETIRED_BACKEND,
  );
  if (!hasRetired) return json;

  const cleaned: Record<string, Record<string, unknown>> = {};
  for (const [agentId, pref] of Object.entries(envelope.data.prefs)) {
    if (pref.backend === RETIRED_BACKEND) {
      const { backend: _retired, ...rest } = pref;
      cleaned[agentId] = rest;
    } else {
      cleaned[agentId] = pref;
    }
  }
  return { ...(typeof json === "object" && json !== null ? json : {}), prefs: cleaned };
}

export class AgentPrefsPersistence {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Read and Zod-validate the on-disk file. Returns the canonical empty shape
   * when the file is missing. Throws on shape violation — bad on-disk state is
   * surfaced, not silently dropped — EXCEPT a retired `backend: "native"`, which
   * is tolerated-and-dropped (see dropRetiredBackend) so the daemon boots against
   * state the prior ADR-0018 effort wrote.
   */
  read(): AgentPrefsFile {
    if (!this.exists()) return EMPTY;
    const raw = readFileSync(this.path, "utf8");
    const json: unknown = JSON.parse(raw);
    return AgentPrefsFileSchema.parse(dropRetiredBackend(json));
  }

  /** Atomic write: stringify → write `<path>.tmp` → rename over `<path>`. */
  write(file: AgentPrefsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const json = JSON.stringify(file, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, this.path);
  }

  /** Remove the file. Safe to call when absent. Used by tests. */
  remove(): void {
    if (this.exists()) unlinkSync(this.path);
  }
}
