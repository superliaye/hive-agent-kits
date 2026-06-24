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
import {
  SOURCES_FILE_VERSION,
  type SourcesFile,
  SourcesFileSchema,
  SourcesFileVersionProbe,
} from "./types.ts";

const EMPTY: SourcesFile = { version: SOURCES_FILE_VERSION, sources: [] };

export class SourcesPersistence {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  // True iff a file is present AND at the CURRENT schema version. The first-run
  // seed gate uses this (not bare `exists()`): a stale-version file is discarded
  // by read() → EMPTY, but it is still PRESENT on disk, so seeding on `!exists()`
  // alone would boot into an empty registry with no Starter. Seeding on
  // `!isCurrentVersion()` re-seeds both an absent file AND a discarded stale one,
  // while a present SAME-version file (even an empty `sources:[]` after the user
  // deleted the Starter) returns true → no re-seed (delete-no-reseed holds).
  isCurrentVersion(): boolean {
    if (!existsSync(this.path)) return false;
    try {
      const probe = SourcesFileVersionProbe.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return probe.success && probe.data.version === SOURCES_FILE_VERSION;
    } catch {
      // Unreadable / non-JSON → treat as not-current (read() will throw on a
      // same-version corrupt file; a parse failure here is a stale/garbage file).
      return false;
    }
  }

  // Read and Zod-validate the on-disk file. Returns the canonical empty shape
  // when missing. Two-step (greenfield, no migration):
  //   1. Peek at `version` only. A file at a DIFFERENT version is from a prior
  //      schema — discard it and return EMPTY (the registry re-seeds). The
  //      version is a `z.literal` in the full schema, so a stale-version file and
  //      a same-version corrupt file are otherwise indistinguishable by the throw.
  //   2. At the CURRENT version, run the full parse and let it THROW on a shape
  //      violation — same-version corruption is not silently dropped (could mean
  //      another tool corrupted the file).
  read(): SourcesFile {
    if (!this.exists()) return EMPTY;
    const raw = readFileSync(this.path, "utf8");
    const json: unknown = JSON.parse(raw);
    const probe = SourcesFileVersionProbe.safeParse(json);
    if (!probe.success || probe.data.version !== SOURCES_FILE_VERSION) return EMPTY;
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
