import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SourceLocator } from "@hive/contract";
import { Effect } from "effect";
import type { SyncError } from "../effect/errors.ts";
import { type GitProcess, GitProcessFailure, productionGitProcess } from "./git-process.ts";
import {
  acquisitionError,
  type ListedEntry,
  resolveListing,
  type TreePath,
  type TreeSnapshot,
} from "./snapshot.ts";
import { DEFAULT_TREE_LIMITS, type TreeLimits } from "./tree-guard.ts";

type WorkingTreeLocator = Extract<SourceLocator, { kind: "working-tree" }>;

export type WorkingTreeAcquireCode =
  | "working_tree_not_allowed"
  | "invalid_subpath"
  | "working_tree_changed"
  | "budget_exceeded"
  | "timeout"
  | "unsafe_tree"
  | "io";

export class WorkingTreeAcquireError extends Error {
  override readonly name = "WorkingTreeAcquireError";
  constructor(
    readonly code: WorkingTreeAcquireCode,
    message: string,
  ) {
    super(message);
  }
}

export type WorkingTreeSnapshotOptions = {
  allowedRoots: readonly string[];
  process?: GitProcess;
  limits: TreeLimits;
};

function containedBy(path: string, root: string): boolean {
  return root === sep ? path.startsWith(sep) : path === root || path.startsWith(root + sep);
}

function safeRelativePath(path: string): boolean {
  return (
    path === "." ||
    (!isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."))
  );
}

function checkDeadline(deadlineMs: number): void {
  if (Date.now() > deadlineMs) {
    throw new WorkingTreeAcquireError("timeout", "working tree capture timed out");
  }
}

function remainingMs(deadlineMs: number): number {
  checkDeadline(deadlineMs);
  return Math.max(1, deadlineMs - Date.now());
}

async function gitOutput(
  git: GitProcess,
  args: readonly string[],
  deadlineMs: number,
): Promise<string> {
  try {
    const result = await git.run(args, { timeoutMs: remainingMs(deadlineMs) });
    checkDeadline(deadlineMs);
    return new TextDecoder().decode(result.stdout);
  } catch (error) {
    if (error instanceof WorkingTreeAcquireError) throw error;
    if (error instanceof GitProcessFailure && error.timedOut) {
      throw new WorkingTreeAcquireError("timeout", "working tree Git inspection timed out");
    }
    if (error instanceof GitProcessFailure) {
      throw new WorkingTreeAcquireError("io", "working tree Git inspection failed");
    }
    throw error;
  }
}

async function gitText(
  git: GitProcess,
  args: readonly string[],
  deadlineMs: number,
): Promise<string> {
  return (await gitOutput(git, args, deadlineMs)).trim();
}

async function snapshotMarker(
  git: GitProcess,
  repoRoot: string,
  subpath: string,
  deadlineMs: number,
): Promise<{ head: string; status: string }> {
  return {
    status: await gitOutput(
      git,
      ["-C", repoRoot, "status", "--porcelain=v2", "-z", "--", subpath],
      deadlineMs,
    ),
    head: await gitText(git, ["-C", repoRoot, "rev-parse", "HEAD"], deadlineMs),
  };
}

function canonicalPath(path: string, code: WorkingTreeAcquireCode, message: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new WorkingTreeAcquireError(code, message);
  }
}

function validateSourcePath(
  repoRoot: string,
  selectedRoot: string,
  repoRelative: string,
  pinnedParents: Map<string, DirectoryIdentity>,
): {
  source: string;
  selectedRelative: string;
  parentIdentity: DirectoryIdentity;
} {
  if (!safeRelativePath(repoRelative) || repoRelative === ".") {
    throw new WorkingTreeAcquireError("unsafe_tree", "Git listed an unsafe working tree path");
  }
  const source = resolve(repoRoot, repoRelative);
  if (!containedBy(source, selectedRoot)) {
    throw new WorkingTreeAcquireError(
      "unsafe_tree",
      "Git listed a path outside the selected subpath",
    );
  }
  const selectedRelative = relative(selectedRoot, source);
  if (!safeRelativePath(selectedRelative) || selectedRelative === ".") {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree path escapes the selected tree");
  }
  // Git should not enumerate through a symlinked parent, but make the staging
  // boundary independent of that implementation detail.
  let parentIdentity: DirectoryIdentity;
  try {
    const path = realpathSync(dirname(source));
    const parentStat = statSync(path);
    if (!parentStat.isDirectory()) throw new Error("not a directory");
    parentIdentity = { path, dev: parentStat.dev, ino: parentStat.ino };
  } catch {
    throw new WorkingTreeRaceError("working tree parent changed before capture");
  }
  if (!containedBy(parentIdentity.path, selectedRoot)) {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree path escapes the selected tree");
  }
  const pinned = pinnedParents.get(parentIdentity.path);
  if (pinned && !sameInode(pinned, parentIdentity)) {
    throw new WorkingTreeRaceError("working tree parent changed before capture");
  }
  if (!pinned) pinnedParents.set(parentIdentity.path, parentIdentity);
  return { source, selectedRelative, parentIdentity };
}

class WorkingTreeRaceError extends Error {
  override readonly name = "WorkingTreeRaceError";
}

type DirectoryIdentity = {
  path: string;
  dev: number;
  ino: number;
};

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function descriptorResolvesWithin(fd: number, selectedRoot: string): boolean {
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    if (!existsSync(root)) continue;
    try {
      return containedBy(realpathSync(join(root, String(fd))), selectedRoot);
    } catch {
      return false;
    }
  }
  return true;
}

function unchangedParent(
  parent: string,
  identity: DirectoryIdentity,
  selectedRoot: string,
): boolean {
  try {
    const path = realpathSync(parent);
    const after = statSync(path);
    return (
      path === identity.path &&
      after.isDirectory() &&
      sameInode(after, identity) &&
      containedBy(path, selectedRoot)
    );
  } catch {
    return false;
  }
}

function fingerprintFile(selectedRelative: string, mode: number, data: Buffer): string {
  return createHash("sha256")
    .update(selectedRelative)
    .update("\0")
    .update(String(mode))
    .update("\0")
    .update(data)
    .digest("hex");
}

// Lists one path without reading file bytes: lstat for the mode, readlink for a
// link. Link targets are resolved later against the listing, never the disk.
function listSourceEntry(
  repoRoot: string,
  selectedRoot: string,
  repoRelative: string,
  pinnedParents: Map<string, DirectoryIdentity>,
): { selectedRelative: string; entry: ListedEntry } {
  const { source, selectedRelative, parentIdentity } = validateSourcePath(
    repoRoot,
    selectedRoot,
    repoRelative,
    pinnedParents,
  );
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(source);
  } catch {
    throw new WorkingTreeRaceError("working tree entry changed before it could be listed");
  }
  if (sourceStat.isSymbolicLink()) {
    let text: string;
    let after: ReturnType<typeof lstatSync>;
    try {
      text = readlinkSync(source);
      after = lstatSync(source);
    } catch {
      throw new WorkingTreeRaceError("working tree link changed while it was read");
    }
    if (
      !sameInode(sourceStat, after) ||
      !after.isSymbolicLink() ||
      !unchangedParent(dirname(source), parentIdentity, selectedRoot)
    ) {
      throw new WorkingTreeRaceError("working tree link changed while it was read");
    }
    return { selectedRelative, entry: { mode: "link", text } };
  }
  if (!sourceStat.isFile()) {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree contains a special file");
  }
  return { selectedRelative, entry: { mode: (sourceStat.mode & 0o111) !== 0 ? "exec" : "file" } };
}

// Reads one listed regular file through a no-follow descriptor whose inode and
// parent directory must stay put for the whole read.
function readListedFile(
  repoRoot: string,
  selectedRoot: string,
  repoRelative: string,
  pinnedParents: Map<string, DirectoryIdentity>,
  maxFileBytes: number,
): { data: Buffer; fingerprint: string } {
  const { source, selectedRelative, parentIdentity } = validateSourcePath(
    repoRoot,
    selectedRoot,
    repoRelative,
    pinnedParents,
  );
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(source);
  } catch {
    throw new WorkingTreeRaceError("working tree entry changed before it could be read");
  }
  if (!sourceStat.isFile()) {
    throw new WorkingTreeRaceError("working tree file changed before it could be read");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | noFollow);
  } catch {
    throw new WorkingTreeRaceError("working tree file changed before it could be opened");
  }
  let data: Buffer;
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !sameInode(sourceStat, opened) ||
      !descriptorResolvesWithin(fd, selectedRoot)
    ) {
      throw new WorkingTreeRaceError("working tree file changed while it was opened");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxFileBytes) {
      throw new WorkingTreeAcquireError("budget_exceeded", "selected tree exceeds byte limit");
    }
    data = readFileSync(fd);
    const after = lstatSync(source);
    if (
      !sameInode(opened, after) ||
      !after.isFile() ||
      !descriptorResolvesWithin(fd, selectedRoot) ||
      !unchangedParent(dirname(source), parentIdentity, selectedRoot)
    ) {
      throw new WorkingTreeRaceError("working tree file changed while it was read");
    }
  } catch (error) {
    if (error instanceof WorkingTreeRaceError || error instanceof WorkingTreeAcquireError) {
      throw error;
    }
    throw new WorkingTreeRaceError("working tree file changed while it was read");
  } finally {
    closeSync(fd);
  }
  return { data, fingerprint: fingerprintFile(selectedRelative, sourceStat.mode & 0o777, data) };
}

async function listedWorkingTreePaths(
  git: GitProcess,
  repoRoot: string,
  subpath: string,
  deadlineMs: number,
): Promise<string[]> {
  const listed = await gitOutput(
    git,
    ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", subpath],
    deadlineMs,
  );
  const deleted = new Set(
    (
      await gitOutput(
        git,
        ["-C", repoRoot, "ls-files", "-z", "--deleted", "--", subpath],
        deadlineMs,
      )
    )
      .split("\0")
      .filter((path) => path.length > 0),
  );
  return listed
    .split("\0")
    .filter((path) => path.length > 0 && !deleted.has(path))
    .sort();
}

function pathsMatch(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((path, index) => path === after[index]);
}

type VerifiedWorkingTree = {
  locator: WorkingTreeLocator;
  topLevel: string;
  selectedRoot: string;
};

async function verifyWorkingTree(
  locator: WorkingTreeLocator,
  options: Pick<WorkingTreeSnapshotOptions, "allowedRoots" | "process"> & { limits?: TreeLimits },
  requireCanonicalTopLevel: boolean,
): Promise<VerifiedWorkingTree> {
  const git = options.process ?? productionGitProcess();
  const limits = options.limits ?? DEFAULT_TREE_LIMITS;
  const deadlineMs = Date.now() + limits.timeoutMs;
  const locatorRoot = canonicalPath(
    locator.repoRoot,
    "working_tree_not_allowed",
    "working tree root is unavailable",
  );
  const topLevel = canonicalPath(
    await gitText(git, ["-C", locatorRoot, "rev-parse", "--show-toplevel"], deadlineMs),
    "working_tree_not_allowed",
    "working tree Git top-level is unavailable",
  );
  if (requireCanonicalTopLevel && topLevel !== locatorRoot) {
    throw new WorkingTreeAcquireError(
      "working_tree_not_allowed",
      "repoRoot must be the Git top-level",
    );
  }
  let topLevelStat: ReturnType<typeof statSync>;
  try {
    topLevelStat = statSync(topLevel);
  } catch {
    throw new WorkingTreeAcquireError(
      "working_tree_not_allowed",
      "working tree Git top-level is unavailable",
    );
  }
  if (!topLevelStat.isDirectory()) {
    throw new WorkingTreeAcquireError(
      "working_tree_not_allowed",
      "working tree Git top-level is unavailable",
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && topLevelStat.uid !== uid) {
    throw new WorkingTreeAcquireError(
      "working_tree_not_allowed",
      "working tree is not owned by the Daemon user",
    );
  }
  const allowlisted = options.allowedRoots.some((allowedRoot) => {
    try {
      return containedBy(topLevel, realpathSync(allowedRoot));
    } catch {
      return false;
    }
  });
  if (!allowlisted) {
    throw new WorkingTreeAcquireError(
      "working_tree_not_allowed",
      "working tree is outside configured roots",
    );
  }
  if (!safeRelativePath(locator.subpath)) {
    throw new WorkingTreeAcquireError("invalid_subpath", "working tree subpath is invalid");
  }
  const selectedRoot = canonicalPath(
    requireCanonicalTopLevel ? resolve(topLevel, locator.subpath) : locatorRoot,
    "invalid_subpath",
    "working tree subpath is unavailable",
  );
  if (!containedBy(selectedRoot, topLevel)) {
    throw new WorkingTreeAcquireError("invalid_subpath", "working tree subpath escapes repoRoot");
  }
  try {
    if (!statSync(selectedRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WorkingTreeAcquireError("invalid_subpath", "working tree subpath is unavailable");
  }
  const canonicalSubpath = relative(topLevel, selectedRoot).split(sep).join("/") || ".";
  if (!safeRelativePath(canonicalSubpath)) {
    throw new WorkingTreeAcquireError("invalid_subpath", "working tree subpath is invalid");
  }
  return {
    locator: { ...locator, repoRoot: topLevel, subpath: canonicalSubpath },
    topLevel,
    selectedRoot,
  };
}

export async function canonicalizeWorkingTreeLocator(
  locator: WorkingTreeLocator,
  options: Pick<WorkingTreeSnapshotOptions, "allowedRoots" | "process"> & { limits?: TreeLimits },
): Promise<WorkingTreeLocator> {
  return (await verifyWorkingTree(locator, options, locator.subpath !== ".")).locator;
}

function syncErrorOf(error: unknown): SyncError {
  if (error instanceof WorkingTreeRaceError) return acquisitionError("working_tree_changed");
  return acquisitionError(error instanceof WorkingTreeAcquireError ? error.code : "io");
}

// Lists tracked and non-ignored untracked files below the selected subpath and
// reads them from disk on demand. `confirm` re-runs the HEAD and status marker
// and the listing, and re-reads every file read so far: any difference fails
// `working_tree_changed`, which the Sync retries once from a fresh snapshot.
export function workingTreeSnapshot(
  locator: WorkingTreeLocator,
  options: WorkingTreeSnapshotOptions,
): Effect.Effect<TreeSnapshot, SyncError> {
  const git = options.process ?? productionGitProcess();
  const { limits } = options;
  const deadlineMs = Date.now() + limits.timeoutMs;
  const pinnedParents = new Map<string, DirectoryIdentity>();
  const fingerprints = new Map<TreePath, string>();
  let bytesRead = 0;
  return Effect.tryPromise({
    try: async () => {
      const verified = await verifyWorkingTree(locator, options, true);
      const { topLevel, selectedRoot } = verified;
      const before = await snapshotMarker(git, topLevel, locator.subpath, deadlineMs);
      if (!/^[0-9a-f]{40}$/.test(before.head)) {
        throw new WorkingTreeAcquireError("io", "working tree HEAD is invalid");
      }
      const paths = await listedWorkingTreePaths(git, topLevel, locator.subpath, deadlineMs);
      if (paths.length > limits.maxListedEntries) {
        throw new WorkingTreeAcquireError("budget_exceeded", "selected tree exceeds listing limit");
      }
      const listed = new Map<TreePath, ListedEntry>();
      const repoRelativeOf = new Map<TreePath, string>();
      for (const repoRelative of paths) {
        checkDeadline(deadlineMs);
        const { selectedRelative, entry } = listSourceEntry(
          topLevel,
          selectedRoot,
          repoRelative,
          pinnedParents,
        );
        const path = selectedRelative.split(sep).join("/") as TreePath;
        if (listed.has(path)) {
          throw new WorkingTreeAcquireError(
            "unsafe_tree",
            "Git listed duplicate working tree paths",
          );
        }
        listed.set(path, entry);
        repoRelativeOf.set(path, repoRelative);
      }
      const read = (path: TreePath, maxFileBytes: number) => {
        const repoRelative = repoRelativeOf.get(path);
        if (repoRelative === undefined || listed.get(path)?.mode === "link") {
          throw new WorkingTreeAcquireError("io", "working tree entry is unavailable");
        }
        return readListedFile(topLevel, selectedRoot, repoRelative, pinnedParents, maxFileBytes);
      };
      const snapshot: TreeSnapshot = {
        origin: {
          transport: "working-tree",
          repoRoot: topLevel,
          subpath: verified.locator.subpath,
          head: before.head,
          dirty: before.status.length > 0,
        },
        entries: resolveListing(listed),
        read: (requested) =>
          Effect.try({
            try: () => {
              const out = new Map<TreePath, Uint8Array>();
              for (const path of requested) {
                checkDeadline(deadlineMs);
                const file = read(path, limits.maxBytes - bytesRead);
                bytesRead += file.data.byteLength;
                fingerprints.set(path, file.fingerprint);
                out.set(path, file.data);
              }
              return out;
            },
            catch: syncErrorOf,
          }),
        confirm: () =>
          Effect.tryPromise({
            try: async () => {
              const after = await snapshotMarker(git, topLevel, locator.subpath, deadlineMs);
              const afterPaths = await listedWorkingTreePaths(
                git,
                topLevel,
                locator.subpath,
                deadlineMs,
              );
              if (
                before.head !== after.head ||
                before.status !== after.status ||
                !pathsMatch(paths, afterPaths)
              ) {
                throw new WorkingTreeRaceError("working tree changed during capture");
              }
              for (const [path, fingerprint] of fingerprints) {
                checkDeadline(deadlineMs);
                let current: string;
                try {
                  current = read(path, limits.maxBytes).fingerprint;
                } catch (error) {
                  if (
                    error instanceof WorkingTreeAcquireError &&
                    error.code === "budget_exceeded"
                  ) {
                    throw error;
                  }
                  throw new WorkingTreeRaceError("working tree entry changed during verification");
                }
                if (current !== fingerprint) {
                  throw new WorkingTreeRaceError("working tree changed during capture");
                }
              }
            },
            catch: syncErrorOf,
          }),
      };
      return snapshot;
    },
    catch: syncErrorOf,
  });
}
