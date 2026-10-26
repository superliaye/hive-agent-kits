// Mirror — the read-only deploy source under the Hive home, and the only writer
// of its bytes. Sync plans a Recipe's projection against a snapshot listing,
// materializes only the planned files into an owned stage, and swaps the stage
// in together with its `.hive-mirror.json` record. The prior Mirror stays in
// place until the new tree is.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { RecipeSummary } from "@hive/contract";
import { Effect, type Scope } from "effect";
import { z } from "zod";
import { log } from "../lib/log.ts";
import {
  acquisitionError,
  type TreeEntry,
  TreeOrigin,
  type TreePath,
  type TreeSnapshot,
} from "./acquisition/snapshot.ts";
import type { TreeLimits } from "./acquisition/tree-guard.ts";
import { SyncError } from "./effect/errors.ts";
import type { Projection, Recognition } from "./recipes/recipe.ts";

const RECORD_FILE = ".hive-mirror.json";
const OWNED_STAGE = /^extract-owner-([1-9]\d*)-/;

// Written inside the stage, so record and bytes swap together. A Mirror without
// a parseable record reads as unavailable until the next Sync rewrites it.
export const MirrorRecord = z.object({
  origin: TreeOrigin,
  fetchedAt: z.number().int(),
  recipe: RecipeSummary,
  // sha256 over the Recipe id and unit and every Mirror file's path, mode, and
  // byte hash. It moves when the projection moves even if the upstream tree did
  // not, and holds still when only unprojected upstream files change.
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type MirrorRecord = z.infer<typeof MirrorRecord>;

export function readMirrorRecord(mirrorRoot: string): MirrorRecord | null {
  try {
    const parsed = MirrorRecord.safeParse(
      JSON.parse(readFileSync(join(mirrorRoot, RECORD_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The Mirror identity the Overview and the Deploy plan bind to.
export function readMirrorIdentity(mirrorRoot: string): string | null {
  return readMirrorRecord(mirrorRoot)?.contentDigest ?? null;
}

export type IngestEntry =
  | { readonly to: string; readonly mode: 0o644 | 0o755; readonly from: TreePath }
  | { readonly to: string; readonly mode: 0o644; readonly text: string };

export type IngestPlan = {
  // Sorted by `to`.
  readonly entries: readonly IngestEntry[];
  readonly dropped: readonly { readonly from: TreePath; readonly reason: string }[];
};

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

const fileMode = (entry: TreeEntry): 0o644 | 0o755 => (entry.mode === "exec" ? 0o755 : 0o644);

// Expands the projection against the listing. A link to a listed file becomes
// that file's bytes and mode; any other link is dropped, so a Mirror holds
// regular files only. The file limit applies here, to what is ingested.
export function planIngest(
  entries: ReadonlyMap<TreePath, TreeEntry>,
  projection: Projection,
  limits: TreeLimits,
): Effect.Effect<IngestPlan, SyncError> {
  const outputs = [
    ...projection.copies.map((copy) => copy.to),
    ...projection.writes.map((write) => write.to),
  ];
  for (let left = 0; left < outputs.length; left++) {
    for (let right = left + 1; right < outputs.length; right++) {
      const a = outputs[left];
      const b = outputs[right];
      if (a !== undefined && b !== undefined && overlaps(a, b)) {
        return Effect.die(new Error(`Recipe projection writes ${a} and ${b} over each other`));
      }
    }
  }
  const planned: IngestEntry[] = [];
  const dropped: { from: TreePath; reason: string }[] = [];
  for (const copy of projection.copies) {
    for (const [path, entry] of entries) {
      const rel =
        path === copy.from
          ? ""
          : copy.from === ""
            ? path
            : path.startsWith(`${copy.from}/`)
              ? path.slice(copy.from.length + 1)
              : null;
      if (rel === null) continue;
      const to = rel ? `${copy.to}/${rel}` : copy.to;
      if (entry.mode !== "link") {
        planned.push({ to, mode: fileMode(entry), from: path });
        continue;
      }
      const target = entry.target === null ? undefined : entries.get(entry.target);
      if (entry.target === null || !target || target.mode === "link") {
        dropped.push({
          from: path,
          reason: entry.target === null ? "link dangles or leaves the tree" : "link to a directory",
        });
        continue;
      }
      planned.push({ to, mode: fileMode(target), from: entry.target });
    }
  }
  for (const write of projection.writes)
    planned.push({ to: write.to, mode: 0o644, text: write.text });
  if (planned.length > limits.maxFiles) return Effect.fail(acquisitionError("budget_exceeded"));
  planned.sort((left, right) => (left.to < right.to ? -1 : left.to > right.to ? 1 : 0));
  return Effect.succeed({ entries: planned, dropped });
}

function liveStageOwner(entry: string): boolean {
  const match = OWNED_STAGE.exec(entry);
  const rawPid = match?.[1];
  if (!rawPid) return false;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function createOwnedMirrorStage(tmpRoot: string): string {
  mkdirSync(tmpRoot, { recursive: true });
  return mkdtempSync(join(tmpRoot, `extract-owner-${process.pid}-`));
}

const mirrorWriteError = (err: unknown) =>
  new SyncError({
    reason: "io",
    message: `mirror write failed: ${String(err)}`,
    detail: "mirror write failed",
  });

export type StagedMirror = { readonly stage: string; readonly record: MirrorRecord };

const READ_BATCH = 128;

// Reads only the planned blobs, in batches, and writes them with their modes
// into a fresh owned stage. The same snapshot and Recognition give the same
// bytes and digest. The scope removes the stage unless commitMirror moved it; a
// crash leaves an owned stage that sweepStaleTmp removes.
export function materialize(
  snapshot: TreeSnapshot,
  recognition: Recognition,
  tmpRoot: string,
  limits: TreeLimits,
): Effect.Effect<StagedMirror, SyncError, Scope.Scope> {
  return Effect.gen(function* () {
    const plan = yield* planIngest(snapshot.entries, recognition.projection, limits);
    for (const drop of plan.dropped) {
      log().warn(
        { module: "kit/mirror", path: drop.from, reason: drop.reason },
        "link left out of the Mirror",
      );
    }
    const stage = yield* Effect.acquireRelease(
      Effect.try({ try: () => createOwnedMirrorStage(tmpRoot), catch: mirrorWriteError }),
      (dir) =>
        Effect.sync(() => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            log().warn({ module: "kit/mirror", err: String(err) }, "mirror stage cleanup failed");
          }
        }),
    );
    const { recipe } = recognition;
    const digest = createHash("sha256").update(`${recipe.id}\0${recipe.unit}\n`);
    for (let start = 0; start < plan.entries.length; start += READ_BATCH) {
      const group = plan.entries.slice(start, start + READ_BATCH);
      const reads = [...new Set(group.flatMap((entry) => ("from" in entry ? [entry.from] : [])))];
      const bytes =
        reads.length > 0 ? yield* snapshot.read(reads) : new Map<TreePath, Uint8Array>();
      yield* Effect.try({
        try: () => {
          for (const entry of group) {
            const data =
              "from" in entry ? bytes.get(entry.from) : new TextEncoder().encode(entry.text);
            if (!data) throw new Error(`snapshot returned no bytes for ${entry.to}`);
            const destination = join(stage, entry.to);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, data);
            chmodSync(destination, entry.mode);
            const hash = createHash("sha256").update(data).digest("hex");
            digest.update(`${entry.to}\0${entry.mode.toString(8)}\0${hash}\n`);
          }
        },
        catch: mirrorWriteError,
      });
    }
    return {
      stage,
      record: {
        origin: snapshot.origin,
        fetchedAt: Date.now(),
        recipe,
        contentDigest: digest.digest("hex"),
      },
    };
  });
}

// "unchanged" when the content digest equals the current record's. The swap
// still happens, so origin and fetchedAt stay true.
export function commitMirror(
  mirrorRoot: string,
  staged: StagedMirror,
): Effect.Effect<{ status: "synced" | "unchanged" }, SyncError> {
  return Effect.try({
    try: () => {
      const prior = readMirrorIdentity(mirrorRoot);
      writeFileSync(join(staged.stage, RECORD_FILE), `${JSON.stringify(staged.record, null, 2)}\n`);
      swapMirror(mirrorRoot, staged.stage)();
      return {
        status:
          prior === staged.record.contentDigest ? ("unchanged" as const) : ("synced" as const),
      };
    },
    catch: mirrorWriteError,
  });
}

// Sweep partial temp extract dirs from Daemons that are no longer alive. Legacy
// and malformed names carry no live owner and are safe crash remnants to remove.
export function sweepStaleTmp(tmpRoot: string): void {
  const root = tmpRoot;
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith("extract-") && !liveStageOwner(entry)) {
      try {
        rmSync(join(root, entry), { recursive: true, force: true });
      } catch (err) {
        log().warn({ module: "kit/mirror", entry, err: String(err) }, "stale tmp sweep failed");
      }
    }
  }
}

// Startup recovery for a crash mid-swap (swapMirror renames mirror→.prev then
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

// Remove a Source's whole Mirror dir on delete, best-effort. An fs
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

// Atomic stage→swap of a fully written stage into the mirror: move the current
// mirror aside (`.prev-<ts>`), move the stage in, then drop the old one. Retains
// last-good until the new tree is in place; restores the prior mirror on a swap
// failure.
type MirrorCleanup = () => void;

function swapMirror(mirrorRoot: string, stageDir: string): MirrorCleanup {
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
  return () => {
    if (!hadPrior) return;
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      log().warn({ module: "kit/mirror", err: String(err) }, "prior mirror cleanup failed");
    }
  };
}
