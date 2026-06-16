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
import { AGENT_PREFS_FILE_VERSION, type AgentPrefsFile, AgentPrefsFileSchema } from "./types.ts";

const EMPTY: AgentPrefsFile = { version: AGENT_PREFS_FILE_VERSION, prefs: {} };

export class AgentPrefsPersistence {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Read and Zod-validate the on-disk file. Returns the canonical empty shape
   * when the file is missing. Throws on shape violation — bad on-disk state is
   * surfaced, not silently dropped.
   */
  read(): AgentPrefsFile {
    if (!this.exists()) return EMPTY;
    const raw = readFileSync(this.path, "utf8");
    const json: unknown = JSON.parse(raw);
    return AgentPrefsFileSchema.parse(json);
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
