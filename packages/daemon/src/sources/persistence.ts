// Disk I/O for the Sources registry.
//
// On-disk format: a single JSON file at `~/.hive/sources.json`. See `types.ts`
// for the schema. Writes are atomic via tmp-file + rename so a mid-write crash
// cannot corrupt the file. Hive-private — never written into the agent-kit
// Deployment Ledger. Mirrors `secrets/persistence.ts` (JSON, not the YAML
// config persistence).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { SOURCES_FILE_VERSION, type SourcesFile, SourcesFileSchema } from "./types.ts";

const EMPTY: SourcesFile = { version: SOURCES_FILE_VERSION, sources: [] };

export class SourcesPersistence {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  // Read and Zod-validate the on-disk file. Returns the canonical empty shape
  // when missing. Throws on shape violation — bad on-disk state is not silently
  // dropped (could mean another tool corrupted the file).
  read(): SourcesFile {
    if (!this.exists()) return EMPTY;
    const raw = readFileSync(this.path, "utf8");
    const json: unknown = JSON.parse(raw);
    return SourcesFileSchema.parse(json);
  }

  // Atomic write: stringify → write `<path>.tmp` → rename over `<path>`. Cannot
  // leave a partial file even if the process dies between steps.
  write(file: SourcesFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const json = JSON.stringify(file, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, this.path);
  }

  remove(): void {
    if (this.exists()) unlinkSync(this.path);
  }
}
