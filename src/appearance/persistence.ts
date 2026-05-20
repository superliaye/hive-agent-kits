// Disk I/O for the Appearance module — same atomic-write pattern as
// Secrets. File mode 0600 is overkill (appearance prefs aren't secret)
// but matches the user-owns-their-home-dir invariant.

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
import {
  APPEARANCE_FILE_VERSION,
  type AppearanceFile,
  AppearanceFileSchema,
  DEFAULT_PREFERENCES,
} from "./types.ts";

const EMPTY: AppearanceFile = {
  version: APPEARANCE_FILE_VERSION,
  preferences: DEFAULT_PREFERENCES,
};

export class AppearancePersistence {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Read + Zod-validate. Returns the default-preferences shape when the
   * file is missing. Throws on shape violation — same policy as Secrets.
   */
  read(): AppearanceFile {
    if (!this.exists()) return EMPTY;
    const raw = readFileSync(this.path, "utf8");
    const json: unknown = JSON.parse(raw);
    return AppearanceFileSchema.parse(json);
  }

  write(file: AppearanceFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const json = JSON.stringify(file, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, json, "utf8");
    try {
      chmodSync(tmp, 0o600);
    } catch (err) {
      log().debug({ module: "appearance", path: tmp, err }, "chmod 0600 failed");
    }
    renameSync(tmp, this.path);
  }

  remove(): void {
    if (this.exists()) unlinkSync(this.path);
  }
}
