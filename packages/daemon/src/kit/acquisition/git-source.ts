import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SourceLocator } from "@hive/contract";
import { commitStagedMirror } from "../mirror.ts";
import type { MirrorProvenance } from "../types.ts";
import { type GitProcess, GitProcessFailure, productionGitProcess } from "./git-process.ts";
import {
  DEFAULT_TREE_LIMITS,
  extractBoundedTree,
  TreeGuardError,
  type TreeLimits,
} from "./tree-guard.ts";

type GitLocator = Extract<SourceLocator, { kind: "git" }>;

export type GitAcquireCode =
  | "auth_or_repository_unavailable"
  | "invalid_locator"
  | "missing_ref"
  | "invalid_subpath"
  | "offline"
  | "timeout"
  | "budget_exceeded"
  | "unsafe_tree"
  | "io";

export class GitAcquireError extends Error {
  override readonly name = "GitAcquireError";
  constructor(
    readonly code: GitAcquireCode,
    message: string,
  ) {
    super(message);
  }
}

export type GitAcquireOptions = {
  cacheRoot: string;
  tmpRoot: string;
  process?: GitProcess;
  limits?: TreeLimits;
};

const repositoryLocks = new Map<string, Promise<void>>();

function normalizedRepositoryUrl(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function safeSubpath(subpath: string): boolean {
  return (
    subpath === "." ||
    (!subpath.startsWith("/") &&
      !subpath.includes("\\") &&
      subpath
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."))
  );
}

function cacheKey(normalizedRepoUrl: string): string {
  return createHash("sha256").update(normalizedRepoUrl).digest("hex");
}

async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = repositoryLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const queued = prior.then(() => current);
  repositoryLocks.set(key, queued);
  await prior;
  try {
    return await work();
  } finally {
    release();
    // The map stores the chained promise, rather than `current` itself. Compare
    // that exact identity so a completed operation cannot leave a stale entry.
    if (repositoryLocks.get(key) === queued) repositoryLocks.delete(key);
  }
}

export function repositoryLockCountForTest(): number {
  return repositoryLocks.size;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

function mapGitFailure(error: unknown, phase: "fetch" | "archive" | "other"): GitAcquireError {
  if (error instanceof GitAcquireError) return error;
  if (!(error instanceof GitProcessFailure))
    return new GitAcquireError("io", "git acquisition failed");
  if (error.timedOut) return new GitAcquireError("timeout", "git acquisition timed out");
  if (error.budgetExceeded) {
    return new GitAcquireError("budget_exceeded", "selected tree exceeds acquisition limits");
  }
  const stderr = error.result.stderr.toLowerCase();
  if (
    stderr.includes("could not resolve host") ||
    stderr.includes("network is unreachable") ||
    stderr.includes("failed to connect") ||
    stderr.includes("connection timed out")
  ) {
    return new GitAcquireError("offline", "repository network is unavailable");
  }
  if (
    phase === "archive" &&
    (stderr.includes("not a valid object name") || stderr.includes("not in the working tree"))
  ) {
    return new GitAcquireError(
      "invalid_subpath",
      "selected subpath does not exist at the requested revision",
    );
  }
  if (
    phase === "fetch" &&
    (stderr.includes("couldn't find remote ref") || stderr.includes("not our ref"))
  ) {
    return new GitAcquireError("missing_ref", "requested revision is unavailable");
  }
  if (phase === "other") return new GitAcquireError("io", "git repository operation failed");
  return new GitAcquireError(
    "auth_or_repository_unavailable",
    "repository authentication failed or the repository is unavailable",
  );
}

export async function acquireGitSource(
  locator: GitLocator,
  destination: string,
  options: GitAcquireOptions,
): Promise<MirrorProvenance> {
  const normalizedRepoUrl = normalizedRepositoryUrl(locator.repoUrl);
  if (!normalizedRepoUrl) {
    throw new GitAcquireError(
      "invalid_locator",
      "git repository URL must be credential-free HTTPS",
    );
  }
  if (!safeSubpath(locator.subpath)) {
    throw new GitAcquireError("invalid_subpath", "selected subpath is invalid");
  }
  const git = options.process ?? productionGitProcess();
  const limits = options.limits ?? DEFAULT_TREE_LIMITS;
  const key = cacheKey(normalizedRepoUrl);
  return locked(key, async () => {
    let stage: string | undefined;
    try {
      const deadlineMs = Date.now() + limits.timeoutMs;
      const daemonEnv = { ...process.env };
      const remainingMs = () => {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) throw new GitAcquireError("timeout", "git acquisition timed out");
        return remaining;
      };
      const run = async (
        args: readonly string[],
        phase: "fetch" | "archive" | "other" = "other",
      ) => {
        try {
          return await git.run(args, { env: daemonEnv, timeoutMs: remainingMs() });
        } catch (error) {
          throw mapGitFailure(error, phase);
        }
      };
      const archive = async (args: readonly string[]) => {
        try {
          return await git.runArchive(args, {
            env: daemonEnv,
            maxBytes: limits.maxBytes,
            timeoutMs: remainingMs(),
          });
        } catch (error) {
          throw mapGitFailure(error, "archive");
        }
      };
      const cache = join(options.cacheRoot, key);
      remainingMs();
      mkdirSync(options.cacheRoot, { recursive: true });
      if (!existsSync(cache)) {
        await run(["init", "--bare", cache]);
        await run(["-C", cache, "config", "extensions.partialClone", "origin"]);
      }
      const requested =
        locator.revision.mode === "track" ? locator.revision.ref : locator.revision.commit;
      await run(
        [
          "-C",
          cache,
          "fetch",
          "--filter=blob:none",
          "--no-tags",
          "--depth=1",
          locator.repoUrl,
          requested,
        ],
        "fetch",
      );
      const resolvedCommit = text(
        (await run(["-C", cache, "rev-parse", "FETCH_HEAD^{commit}"])).stdout,
      );
      if (!/^[0-9a-f]{40}$/.test(resolvedCommit)) {
        throw new GitAcquireError("io", "git returned an invalid resolved commit");
      }
      if (locator.revision.mode === "pin" && locator.revision.commit !== resolvedCommit) {
        throw new GitAcquireError("missing_ref", "requested pinned commit did not resolve exactly");
      }
      const treeish =
        locator.subpath === "." ? resolvedCommit : `${resolvedCommit}:${locator.subpath}`;
      const archiveTar = (await archive(["-C", cache, "archive", "--format=tar", treeish])).stdout;
      const treeIdentity = text(
        (
          await run([
            "-C",
            cache,
            "rev-parse",
            locator.subpath === "."
              ? `${resolvedCommit}^{tree}`
              : `${resolvedCommit}:${locator.subpath}`,
          ])
        ).stdout,
      );
      remainingMs();
      mkdirSync(options.tmpRoot, { recursive: true });
      stage = mkdtempSync(join(options.tmpRoot, "extract-git-"));
      extractBoundedTree(archiveTar, stage, limits, deadlineMs);
      const provenance: MirrorProvenance = {
        sha: resolvedCommit,
        fetchedAt: Date.now(),
        transport: "git",
        repoUrl: locator.repoUrl,
        requestedRevision: locator.revision,
        resolvedCommit,
        subpath: locator.subpath,
        treeIdentity,
      };
      remainingMs();
      commitStagedMirror(destination, stage, provenance);
      stage = undefined;
      remainingMs();
      return provenance;
    } catch (error) {
      if (stage) {
        try {
          rmSync(stage, { recursive: true, force: true });
        } catch {
          // The original acquisition error remains the stable caller boundary.
        }
      }
      if (error instanceof GitAcquireError) throw error;
      if (error instanceof TreeGuardError) throw new GitAcquireError(error.code, error.message);
      throw new GitAcquireError("io", "git acquisition filesystem operation failed");
    }
  });
}
