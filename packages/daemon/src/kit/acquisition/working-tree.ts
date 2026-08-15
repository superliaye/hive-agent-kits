import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SourceLocator } from "@hive/contract";
import { commitStagedMirror, createOwnedMirrorStage } from "../mirror.ts";
import type { MirrorProvenance } from "../types.ts";
import { type GitProcess, GitProcessFailure, productionGitProcess } from "./git-process.ts";
import { DEFAULT_TREE_LIMITS, type TreeLimits } from "./tree-guard.ts";

type WorkingTreeLocator = Extract<SourceLocator, { kind: "working-tree" }>;

export type WorkingTreeProvenance = MirrorProvenance;

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

export type WorkingTreeAcquireOptions = {
  allowedRoots: readonly string[];
  tmpRoot: string;
  process?: GitProcess;
  limits?: TreeLimits;
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

function safeDestination(stage: string, relativePath: string): string {
  if (!safeRelativePath(relativePath) || relativePath === ".") {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree contains an unsafe path");
  }
  const destination = resolve(stage, relativePath);
  if (!containedBy(destination, resolve(stage))) {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree path escapes the selected tree");
  }
  return destination;
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

function safelyResolvesWithin(source: string, target: string, selectedRoot: string): boolean {
  if (isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.includes("\\")) return false;
  const lexicalTarget = resolve(dirname(source), target);
  if (!containedBy(lexicalTarget, selectedRoot)) return false;
  try {
    return containedBy(realpathSync(lexicalTarget), selectedRoot);
  } catch (error: unknown) {
    // A dangling but lexically-internal link is safe to preserve. Other
    // resolution failures (loops, permissions, non-directory components) are not.
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
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

type SourceEntry =
  | {
      selectedRelative: string;
      kind: "file";
      mode: number;
      data: Buffer;
      fingerprint: string;
    }
  | {
      selectedRelative: string;
      kind: "link";
      mode: number;
      target: string;
      fingerprint: string;
    };

function fingerprintEntry(
  selectedRelative: string,
  mode: number,
  kind: SourceEntry["kind"],
  content: string | Buffer,
): string {
  return createHash("sha256")
    .update(selectedRelative)
    .update("\0")
    .update(String(mode))
    .update("\0")
    .update(kind)
    .update("\0")
    .update(content)
    .digest("hex");
}

function readSourceEntry(
  repoRoot: string,
  selectedRoot: string,
  repoRelative: string,
  pinnedParents: Map<string, DirectoryIdentity>,
): SourceEntry {
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
  const mode = sourceStat.mode & 0o777;
  if (sourceStat.isSymbolicLink()) {
    let target: string;
    let after: ReturnType<typeof lstatSync>;
    try {
      target = readlinkSync(source);
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
    if (!safelyResolvesWithin(source, target, selectedRoot)) {
      throw new WorkingTreeAcquireError("unsafe_tree", "working tree link escapes selected tree");
    }
    return {
      selectedRelative,
      kind: "link",
      mode,
      target,
      fingerprint: fingerprintEntry(selectedRelative, mode, "link", target),
    };
  }
  if (!sourceStat.isFile()) {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree contains a special file");
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
    if (error instanceof WorkingTreeRaceError) throw error;
    throw new WorkingTreeRaceError("working tree file changed while it was read");
  } finally {
    closeSync(fd);
  }
  return {
    selectedRelative,
    kind: "file",
    mode,
    data,
    fingerprint: fingerprintEntry(selectedRelative, mode, "file", data),
  };
}

function fingerprintsMatch(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): boolean {
  return (
    before.size === after.size &&
    [...before].every(([path, fingerprint]) => after.get(path) === fingerprint)
  );
}

type VerifiedWorkingTree = {
  locator: WorkingTreeLocator;
  topLevel: string;
  selectedRoot: string;
};

async function verifyWorkingTree(
  locator: WorkingTreeLocator,
  options: Pick<WorkingTreeAcquireOptions, "allowedRoots" | "process" | "limits">,
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
    resolve(topLevel, locator.subpath),
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
  return {
    locator: { ...locator, repoRoot: topLevel },
    topLevel,
    selectedRoot,
  };
}

export async function canonicalizeWorkingTreeLocator(
  locator: WorkingTreeLocator,
  options: Pick<WorkingTreeAcquireOptions, "allowedRoots" | "process" | "limits">,
): Promise<WorkingTreeLocator> {
  return (await verifyWorkingTree(locator, options, false)).locator;
}

export async function acquireWorkingTree(
  locator: WorkingTreeLocator,
  destination: string,
  options: WorkingTreeAcquireOptions,
): Promise<WorkingTreeProvenance> {
  const git = options.process ?? productionGitProcess();
  const limits = options.limits ?? DEFAULT_TREE_LIMITS;
  const deadlineMs = Date.now() + limits.timeoutMs;
  const verified = await verifyWorkingTree(locator, options, true);
  const { topLevel, selectedRoot } = verified;
  const pinnedParents = new Map<string, DirectoryIdentity>();

  for (let attempt = 0; attempt < 2; attempt++) {
    let stage: string | undefined;
    try {
      const before = await snapshotMarker(git, topLevel, locator.subpath, deadlineMs);
      const listed = await gitOutput(
        git,
        [
          "-C",
          topLevel,
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          locator.subpath,
        ],
        deadlineMs,
      );
      const paths = listed.split("\0").filter((path) => path.length > 0);
      checkDeadline(deadlineMs);
      stage = createOwnedMirrorStage(options.tmpRoot);
      const identity = createHash("sha256");
      const seen = new Set<string>();
      const capturedFingerprints = new Map<string, string>();
      let files = 0;
      let bytes = 0;
      for (const repoRelative of paths) {
        checkDeadline(deadlineMs);
        const entry = readSourceEntry(topLevel, selectedRoot, repoRelative, pinnedParents);
        if (seen.has(entry.selectedRelative)) {
          throw new WorkingTreeAcquireError(
            "unsafe_tree",
            "Git listed duplicate working tree paths",
          );
        }
        seen.add(entry.selectedRelative);
        capturedFingerprints.set(entry.selectedRelative, entry.fingerprint);
        const output = safeDestination(stage, entry.selectedRelative);
        files++;
        if (files > limits.maxFiles) {
          throw new WorkingTreeAcquireError("budget_exceeded", "selected tree exceeds file limit");
        }
        mkdirSync(dirname(output), { recursive: true });
        identity.update(entry.selectedRelative).update("\0").update(String(entry.mode));
        if (entry.kind === "link") {
          identity.update("link\0").update(entry.target).update("\0");
          symlinkSync(entry.target, output);
          continue;
        }
        bytes += entry.data.byteLength;
        if (bytes > limits.maxBytes) {
          throw new WorkingTreeAcquireError("budget_exceeded", "selected tree exceeds byte limit");
        }
        identity.update("file\0").update(entry.data).update("\0");
        writeFileSync(output, entry.data);
        chmodSync(output, entry.mode);
      }
      const after = await snapshotMarker(git, topLevel, locator.subpath, deadlineMs);
      const afterFingerprints = new Map<string, string>();
      let afterFiles = 0;
      let afterBytes = 0;
      for (const repoRelative of paths) {
        checkDeadline(deadlineMs);
        let entry: SourceEntry;
        try {
          entry = readSourceEntry(topLevel, selectedRoot, repoRelative, pinnedParents);
        } catch {
          throw new WorkingTreeRaceError("working tree entry changed during verification");
        }
        afterFiles++;
        if (afterFiles > limits.maxFiles) {
          throw new WorkingTreeAcquireError("budget_exceeded", "selected tree exceeds file limit");
        }
        if (entry.kind === "file") {
          afterBytes += entry.data.byteLength;
          if (afterBytes > limits.maxBytes) {
            throw new WorkingTreeAcquireError(
              "budget_exceeded",
              "selected tree exceeds byte limit",
            );
          }
        }
        afterFingerprints.set(entry.selectedRelative, entry.fingerprint);
      }
      if (
        before.head !== after.head ||
        before.status !== after.status ||
        !fingerprintsMatch(capturedFingerprints, afterFingerprints)
      ) {
        if (attempt === 0) {
          rmSync(stage, { recursive: true, force: true });
          stage = undefined;
          continue;
        }
        throw new WorkingTreeAcquireError(
          "working_tree_changed",
          "working tree changed during capture",
        );
      }
      if (!/^[0-9a-f]{40}$/.test(after.head)) {
        throw new WorkingTreeAcquireError("io", "working tree HEAD is invalid");
      }
      checkDeadline(deadlineMs);
      const provenance: WorkingTreeProvenance = {
        sha: after.head,
        fetchedAt: Date.now(),
        transport: "working-tree",
        repoRoot: topLevel,
        resolvedCommit: after.head,
        subpath: locator.subpath,
        treeIdentity: identity.digest("hex"),
        dirty: after.status.length > 0,
      };
      const cleanup = commitStagedMirror(destination, stage, provenance);
      stage = undefined;
      cleanup();
      return provenance;
    } catch (error) {
      if (stage) {
        try {
          rmSync(stage, { recursive: true, force: true });
        } catch {
          // Keep the original stable acquisition error at the caller boundary.
        }
      }
      if (error instanceof WorkingTreeRaceError) {
        if (attempt === 0) continue;
        throw new WorkingTreeAcquireError(
          "working_tree_changed",
          "working tree changed during capture",
        );
      }
      if (error instanceof WorkingTreeAcquireError) throw error;
      throw new WorkingTreeAcquireError("io", "working tree could not be captured");
    }
  }
  throw new WorkingTreeAcquireError("working_tree_changed", "working tree changed during capture");
}
