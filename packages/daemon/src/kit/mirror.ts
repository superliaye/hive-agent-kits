// Mirror — the read-only deploy source under the Hive home.
//
// Holds the extracted Kit tree plus a provenance file ({sha, fetchedAt}). The
// atomic swap (writeMirror) extracts into a fresh temp dir then rename-swaps,
// retaining the prior mirror until the new one is in place.

import {
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
import type { DeployTargets } from "./targets.ts";
import { MirrorProvenance } from "./types.ts";

const PROVENANCE_FILE = ".hive-mirror.json";

export function readProvenance(targets: DeployTargets): MirrorProvenance | null {
  const p = join(targets.mirrorRoot(), PROVENANCE_FILE);
  if (!existsSync(p)) return null;
  try {
    return MirrorProvenance.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function mirrorExists(targets: DeployTargets): boolean {
  return existsSync(join(targets.mirrorRoot(), "capabilities"));
}

// Sweep stale partial temp extract dirs from a prior aborted sync. Called on
// startup and before each new extraction.
export function sweepStaleTmp(targets: DeployTargets): void {
  const root = targets.kitTmpRoot();
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
export function recoverMirror(targets: DeployTargets): void {
  const mirrorRoot = targets.mirrorRoot();
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
  targets: DeployTargets,
  tarBuf: Uint8Array,
  sha: string,
): MirrorProvenance {
  sweepStaleTmp(targets);
  const tmpRoot = targets.kitTmpRoot();
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
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
    }
  }

  const provenance: MirrorProvenance = { sha, fetchedAt: Date.now() };
  writeFileSync(join(stageDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);

  // Atomic swap: move the current mirror aside, move the stage in, then drop the
  // old one. Retains last-good until the new tree is in place.
  const mirrorRoot = targets.mirrorRoot();
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
  return provenance;
}
