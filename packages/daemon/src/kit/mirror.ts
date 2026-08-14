// Mirror — the read-only deploy source under the Hive home.
//
// Holds the extracted Kit tree plus a provenance file ({sha, fetchedAt}). The
// atomic swap (writeMirror) extracts into a fresh temp dir then rename-swaps,
// retaining the prior mirror until the new one is in place.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { log } from "../lib/log.ts";
import { parseTar, topFolder } from "./tar.ts";
import { MirrorProvenance } from "./types.ts";

const PROVENANCE_FILE = ".hive-mirror.json";

export function readProvenance(mirrorRoot: string): MirrorProvenance | null {
  const p = join(mirrorRoot, PROVENANCE_FILE);
  if (!existsSync(p)) return null;
  try {
    return MirrorProvenance.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function mirrorExists(mirrorRoot: string): boolean {
  return existsSync(join(mirrorRoot, "capabilities"));
}

// Sweep stale partial temp extract dirs from a prior aborted sync. Called on
// startup and before each new extraction. The tmp root is shared across Sources
// (each extraction stages into a uniquely-named extract-<sha>-<ts> dir).
export function sweepStaleTmp(tmpRoot: string): void {
  const root = tmpRoot;
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith("extract-")) {
      try {
        rmSync(join(root, entry), { recursive: true, force: true });
      } catch (err) {
        log().warn({ module: "kit/mirror", entry, err: String(err) }, "stale tmp sweep failed");
      }
    }
  }
}

// Startup recovery for a crash mid-swap (writeMirror renames mirror→.prev then
// stage→mirror; a crash between the two leaves the only copy under .prev). If
// mirrorRoot is missing but a `.prev-*` backup exists, restore the newest one;
// then sweep any leftover `.prev-*` backups so they don't accumulate.
export function recoverMirror(mirrorRoot: string): void {
  const parent = dirname(mirrorRoot);
  if (!existsSync(parent)) return;
  const base = mirrorRoot.split(/[\\/]/).pop() ?? "mirror";
  const prevPrefix = `${base}.prev-`;
  const backups = readdirSync(parent)
    .filter((e) => e.startsWith(prevPrefix))
    .map((e) => join(parent, e))
    .sort();
  if (backups.length === 0) return;

  if (!existsSync(mirrorRoot)) {
    // Restore the newest backup (lexicographic sort on the ms timestamp suffix).
    const newest = backups[backups.length - 1];
    if (newest) {
      try {
        renameSync(newest, mirrorRoot);
        log().info(
          { module: "kit/mirror", restored: newest },
          "recovered mirror from crash backup",
        );
      } catch (err) {
        log().warn({ module: "kit/mirror", err: String(err) }, "mirror crash-recovery failed");
      }
    }
  }
  // Sweep any remaining backups (the restored one is gone from the list).
  for (const b of backups) {
    if (!existsSync(b)) continue;
    try {
      rmSync(b, { recursive: true, force: true });
    } catch (err) {
      log().warn({ module: "kit/mirror", b, err: String(err) }, "prev-mirror sweep failed");
    }
  }
}

// Remove a Source's whole Mirror dir on delete (#36, Q7), best-effort. An fs
// fault must NOT fail the delete — the registry row is already gone; a lingering
// Mirror is harmless (deactivated/deleted Sources never aggregate). Models the
// sweepStaleTmp best-effort pattern: rmSync recursive+force in try/catch, trace on
// fault, never throw. The lifecycle adapter wraps this as Effect<void>.
export function removeMirror(mirrorRoot: string): void {
  try {
    rmSync(mirrorRoot, { recursive: true, force: true });
  } catch (err) {
    log().warn({ module: "kit/mirror", mirrorRoot, err: String(err) }, "mirror cleanup failed");
  }
}

// Reject an archive entry whose extracted destination would escape the stage
// dir — absolute paths, drive-letter-rooted paths, and `..` traversal alike.
function destEscapes(stageDir: string, rel: string): boolean {
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return true;
  const resolved = resolve(stageDir, rel);
  const root = resolve(stageDir);
  return resolved !== root && !resolved.startsWith(root + sep);
}

// Extract a gzip'd codeload tarball into the mirror, atomically. The top-folder
// strip is content-derived (topFolder). Returns the provenance written.
export function writeMirror(
  mirrorRoot: string,
  tmpRoot: string,
  tarBuf: Uint8Array,
  sha: string,
): MirrorProvenance {
  sweepStaleTmp(tmpRoot);
  mkdirSync(tmpRoot, { recursive: true });
  const stageDir = join(tmpRoot, `extract-${sha.slice(0, 12)}-${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });

  const entries = parseTar(tarBuf);
  const strip = topFolder(entries);
  const stripPrefix = strip ? `${strip}/` : "";

  for (const entry of entries) {
    const rel =
      stripPrefix && entry.path.startsWith(stripPrefix)
        ? entry.path.slice(stripPrefix.length)
        : entry.path;
    if (!rel) continue;
    // Refuse any entry whose destination would escape the stage dir (traversal,
    // absolute, or drive-letter-rooted).
    if (destEscapes(stageDir, rel)) continue;
    const dest = join(stageDir, rel);
    if (entry.type === "dir") {
      mkdirSync(dest, { recursive: true });
    } else if (entry.type === "file") {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
    }
  }

  const provenance: MirrorProvenance = { sha, fetchedAt: Date.now() };
  writeFileSync(join(stageDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);

  swapMirror(mirrorRoot, stageDir);
  return provenance;
}

// Atomic stage→swap of a PRE-POPULATED stage dir into the mirror: move the
// current mirror aside (`.prev-<ts>`), move the stage in, then drop the old one.
// Retains last-good until the new tree is in place; restores the prior mirror on
// a swap failure. Shared by both writeMirror (tar path) and localSyncMirror
// (copy path) — the only common tail; tar parse/strip/traversal stay in
// writeMirror, copy concerns stay in localSyncMirror.
function swapMirror(mirrorRoot: string, stageDir: string): void {
  mkdirSync(dirname(mirrorRoot), { recursive: true });
  const backup = `${mirrorRoot}.prev-${Date.now()}`;
  const hadPrior = existsSync(mirrorRoot);
  if (hadPrior) renameSync(mirrorRoot, backup);
  try {
    renameSync(stageDir, mirrorRoot);
  } catch (err) {
    // Restore the prior mirror on swap failure (last-good guarantee).
    if (hadPrior && existsSync(backup) && !existsSync(mirrorRoot)) {
      renameSync(backup, mirrorRoot);
    }
    throw err;
  }
  if (hadPrior) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      log().warn({ module: "kit/mirror", err: String(err) }, "prior mirror cleanup failed");
    }
  }
}

export function commitStagedMirror(
  mirrorRoot: string,
  stageDir: string,
  provenance: MirrorProvenance,
): void {
  writeFileSync(join(stageDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  swapMirror(mirrorRoot, stageDir);
}

// Thrown by localSyncMirror when the bundled Starter content root (its
// `capabilities/`) is absent — a bad HIVE_STARTER_ROOT override or a packaging
// miss. A dedicated class so the Effect boundary (localSyncSource) discriminates
// by `instanceof`, NOT by matching the human-readable message text.
export class MissingStarterRoot extends Error {
  override readonly name = "MissingStarterRoot";
}

// Local Sync (#32): copy the bundled Starter's `capabilities/` + `presets/` from
// `starterRoot` into a staged dir, then atomically swap it into the mirror —
// producing a NORMAL Mirror the catalog/deploy already read, with no network and
// no tar. Writes NO provenance file: MirrorProvenance mandates a 40-hex sha, and
// a local mirror has none (the sync-status derives "local" from Source.kind, not
// from provenance). Re-copies on every call (no sha to short-circuit on) — that
// is how a bundled-content update propagates when the app updates. Throws
// MissingStarterRoot on an absent content root, or a bare Error on a copy/swap
// fault; the caller maps both to a typed per-source SyncError (never a raw throw
// out of the sync loop).
export function localSyncMirror(mirrorRoot: string, tmpRoot: string, starterRoot: string): void {
  const capsSrc = join(starterRoot, "capabilities");
  if (!existsSync(capsSrc)) {
    throw new MissingStarterRoot(`starter capabilities not found at ${capsSrc}`);
  }

  sweepStaleTmp(tmpRoot);
  mkdirSync(tmpRoot, { recursive: true });
  const stageDir = join(tmpRoot, `extract-local-${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });

  cpSync(capsSrc, join(stageDir, "capabilities"), { recursive: true });
  const presetsSrc = join(starterRoot, "presets");
  if (existsSync(presetsSrc)) {
    cpSync(presetsSrc, join(stageDir, "presets"), { recursive: true });
  }

  swapMirror(mirrorRoot, stageDir);
}
