import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { commitStagedMirror } from "../mirror.ts";
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
): {
  source: string;
  selectedRelative: string;
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
  if (
    !containedBy(
      canonicalPath(dirname(source), "unsafe_tree", "working tree path is unavailable"),
      selectedRoot,
    )
  ) {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree path escapes the selected tree");
  }
  return { source, selectedRelative };
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
): SourceEntry {
  const { source, selectedRelative } = validateSourcePath(repoRoot, selectedRoot, repoRelative);
  const sourceStat = lstatSync(source);
  const mode = sourceStat.mode & 0o777;
  if (sourceStat.isSymbolicLink()) {
    const target = readlinkSync(source);
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
  if (
    !containedBy(
      canonicalPath(source, "unsafe_tree", "working tree file is unavailable"),
      selectedRoot,
    )
  ) {
    throw new WorkingTreeAcquireError("unsafe_tree", "working tree file escapes selected tree");
  }
  const data = readFileSync(source);
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

export async function acquireWorkingTree(
  locator: WorkingTreeLocator,
  destination: string,
  options: WorkingTreeAcquireOptions,
): Promise<WorkingTreeProvenance> {
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
  if (topLevel !== locatorRoot) {
    throw new WorkingTreeAcquireError(
      "working_tree_not_allowed",
      "repoRoot must be the Git top-level",
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && statSync(topLevel).uid !== uid) {
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
      mkdirSync(options.tmpRoot, { recursive: true });
      checkDeadline(deadlineMs);
      stage = mkdtempSync(join(options.tmpRoot, "extract-working-tree-"));
      const identity = createHash("sha256");
      const seen = new Set<string>();
      const capturedFingerprints = new Map<string, string>();
      let files = 0;
      let bytes = 0;
      for (const repoRelative of paths) {
        checkDeadline(deadlineMs);
        const entry = readSourceEntry(topLevel, selectedRoot, repoRelative);
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
        const entry = readSourceEntry(topLevel, selectedRoot, repoRelative);
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
      commitStagedMirror(destination, stage, provenance);
      stage = undefined;
      return provenance;
    } catch (error) {
      if (stage) rmSync(stage, { recursive: true, force: true });
      if (error instanceof WorkingTreeAcquireError) throw error;
      throw new WorkingTreeAcquireError("io", "working tree could not be captured");
    }
  }
  throw new WorkingTreeAcquireError("working_tree_changed", "working tree changed during capture");
}
