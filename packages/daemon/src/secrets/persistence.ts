// Disk I/O for the Secrets module.
//
// On-disk format: a single JSON file at `~/.hive/secrets.json`. See
// `types.ts` for the schema. Writes are atomic via tmp-file + rename so a
// mid-write crash (or interrupted refresh) cannot corrupt the file. File
// mode is 0600 on POSIX; Windows ignores the bits but the file is per-user
// inside the user's home dir, which is the same threat model as `.token`
// (ADR-0002 §"User data location").

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { log } from "../lib/log.ts";
import { SECRETS_FILE_VERSION, type SecretsFile, SecretsFileSchema } from "./types.ts";

const EMPTY: SecretsFile = { version: SECRETS_FILE_VERSION, secrets: {} };

export class SecretsPersistence {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Read and Zod-validate the on-disk file. Returns the canonical empty
   * shape if the file is missing. Throws on shape violation — bad on-disk
   * state is *not* silently dropped (could mean another tool corrupted the
   * file; surfacing forces investigation).
   */
  read(): SecretsFile {
    if (!this.exists()) return EMPTY;
    const raw = readFileSync(this.path, "utf8");
    const json: unknown = JSON.parse(raw);
    return SecretsFileSchema.parse(json);
  }

  /**
   * Atomic write: stringify → write `<path>.tmp` → fsync (via rename
   * semantics) → rename over `<path>`. Cannot leave a partial file on
   * disk even if the process dies between the two steps.
   *
   * `chmodSync(0o600)` is best-effort on Windows (the call succeeds but
   * the ACL is not narrowed; per-user home is the threat-model boundary).
   */
  write(file: SecretsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const json = JSON.stringify(file, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, json, "utf8");
    try {
      chmodSync(tmp, 0o600);
    } catch (err) {
      // Best-effort on Windows; log but don't abort the write — the file
      // still lands in the user's home dir.
      log().debug({ module: "secrets", path: tmp, err }, "chmod 0600 failed (windows?)");
    }
    renameSync(tmp, this.path);
  }

  /**
   * Remove the file. Used by tests and explicit "log out everywhere" flow.
   * Safe to call when the file doesn't exist.
   */
  remove(): void {
    if (this.exists()) unlinkSync(this.path);
  }
}
