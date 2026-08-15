import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SourceLocator } from "@hive/contract";
import { commitStagedMirror, createOwnedMirrorStage } from "../mirror.ts";
import type { MirrorProvenance } from "../types.ts";
import {
  type GitProcess,
  GitProcessFailure,
  type GitProcessResult,
  productionGitProcess,
} from "./git-process.ts";
import { DEFAULT_TREE_LIMITS, type TreeLimits } from "./tree-guard.ts";

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
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
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
    if (repositoryLocks.get(key) === queued) repositoryLocks.delete(key);
  }
}

export function repositoryLockCountForTest(): number {
  return repositoryLocks.size;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

type GitPhase = "fetch" | "subpath" | "other";

function httpsOnly(args: readonly string[]): readonly string[] {
  return ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...args];
}

function httpsOnlyEnv(daemonEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...daemonEnv, GIT_ALLOW_PROTOCOL: "https" };
}

function mapGitFailure(error: unknown, phase: GitPhase): GitAcquireError {
  if (error instanceof GitAcquireError) return error;
  if (!(error instanceof GitProcessFailure)) {
    return new GitAcquireError("io", "git acquisition failed");
  }
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
  if (phase === "subpath") {
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

function partialFilterUnsupported(stderr: string): boolean {
  const detail = stderr.toLowerCase();
  return (
    (detail.includes("filter") &&
      detail.includes("not recognized") &&
      detail.includes("ignoring")) ||
    (detail.includes("filter") &&
      (detail.includes("does not support") ||
        detail.includes("not supported") ||
        detail.includes("unsupported")))
  );
}

function containedBy(path: string, root: string): boolean {
  return root === sep ? path.startsWith(sep) : path === root || path.startsWith(root + sep);
}

function safeTreePath(stage: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new GitAcquireError("unsafe_tree", "git tree contains an unsafe path");
  }
  const destination = resolve(stage, path);
  if (!containedBy(destination, resolve(stage))) {
    throw new GitAcquireError("unsafe_tree", "git tree path escapes the selected tree");
  }
  return destination;
}

function safeLinkTarget(path: string, target: string, stage: string): boolean {
  if (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    isAbsolute(target) ||
    /^[A-Za-z]:/.test(target)
  ) {
    return false;
  }
  return containedBy(resolve(stage, dirname(path), target), resolve(stage));
}

type RawEntry = {
  path: string;
  mode: "100644" | "100755" | "120000";
  data: Uint8Array;
};

async function materializeRawTree(
  git: GitProcess,
  cache: string,
  treeIdentity: string,
  stage: string,
  limits: TreeLimits,
  deadlineMs: number,
  daemonEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const remainingMs = () => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new GitAcquireError("timeout", "git acquisition timed out");
    return remaining;
  };
  const metadataLimit = Math.max(1, Math.min(128 * 1024 * 1024, limits.maxFiles * 8192));
  const networkSafeEnv = httpsOnlyEnv(daemonEnv);
  let listing: Uint8Array;
  try {
    listing = (
      await git.run(["-C", cache, "ls-tree", "-r", "-z", treeIdentity], {
        env: daemonEnv,
        timeoutMs: remainingMs(),
        maxStdoutBytes: metadataLimit,
      })
    ).stdout;
  } catch (error) {
    throw mapGitFailure(error, "other");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(listing);
  } catch {
    throw new GitAcquireError("unsafe_tree", "git tree contains a non-UTF-8 path");
  }
  const records = decoded.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length > limits.maxFiles) {
    throw new GitAcquireError("budget_exceeded", "selected tree exceeds file limit");
  }
  const entries: RawEntry[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  for (const record of records) {
    remainingMs();
    const tab = record.indexOf("\t");
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})$/.exec(
      tab < 0 ? "" : record.slice(0, tab),
    );
    if (!match || tab < 0) {
      throw new GitAcquireError("unsafe_tree", "git tree contains an unsupported entry");
    }
    const path = record.slice(tab + 1);
    safeTreePath(stage, path);
    if (paths.has(path)) {
      throw new GitAcquireError("unsafe_tree", "git tree contains duplicate paths");
    }
    paths.add(path);
    const mode = match[1] as RawEntry["mode"];
    const objectId = match[2];
    if (!objectId) throw new GitAcquireError("io", "git tree entry is incomplete");
    let data: Uint8Array;
    try {
      data = (
        await git.run(httpsOnly(["-C", cache, "cat-file", "blob", objectId]), {
          env: networkSafeEnv,
          timeoutMs: remainingMs(),
          maxStdoutBytes: Math.max(1, limits.maxBytes - bytes),
        })
      ).stdout;
    } catch (error) {
      throw mapGitFailure(error, "other");
    }
    bytes += data.byteLength;
    if (bytes > limits.maxBytes) {
      throw new GitAcquireError("budget_exceeded", "selected tree exceeds byte limit");
    }
    entries.push({ path, mode, data });
  }

  const sortedPaths = [...paths].sort();
  for (let index = 1; index < sortedPaths.length; index++) {
    const prior = sortedPaths[index - 1];
    const current = sortedPaths[index];
    if (prior && current?.startsWith(`${prior}/`)) {
      throw new GitAcquireError("unsafe_tree", "git tree contains conflicting paths");
    }
  }
  for (const entry of entries) {
    remainingMs();
    const destination = safeTreePath(stage, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    if (entry.mode === "120000") {
      let target: string;
      try {
        target = new TextDecoder("utf-8", { fatal: true }).decode(entry.data);
      } catch {
        throw new GitAcquireError("unsafe_tree", "git tree link target is invalid");
      }
      if (!safeLinkTarget(entry.path, target, stage)) {
        throw new GitAcquireError("unsafe_tree", "git tree link escapes the selected tree");
      }
      symlinkSync(target, destination);
    } else {
      writeFileSync(destination, entry.data);
      chmodSync(destination, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
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
      "git repository URL must be credential-free HTTPS without query or fragment",
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
      const daemonEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
      const remainingMs = () => {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) throw new GitAcquireError("timeout", "git acquisition timed out");
        return remaining;
      };
      const run = async (
        args: readonly string[],
        phase: GitPhase = "other",
        maxStdoutBytes?: number,
        networkCapable = false,
      ) => {
        try {
          return await git.run(networkCapable ? httpsOnly(args) : args, {
            env: networkCapable ? httpsOnlyEnv(daemonEnv) : daemonEnv,
            timeoutMs: remainingMs(),
            ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
          });
        } catch (error) {
          throw mapGitFailure(error, phase);
        }
      };

      const cache = join(options.cacheRoot, key);
      mkdirSync(options.cacheRoot, { recursive: true });
      if (existsSync(cache)) {
        let valid = false;
        try {
          const inspect = async (args: readonly string[], maxStdoutBytes: number) =>
            text(
              (
                await git.run(args, {
                  env: daemonEnv,
                  timeoutMs: remainingMs(),
                  maxStdoutBytes,
                })
              ).stdout,
            );
          const bare = await inspect(["-C", cache, "rev-parse", "--is-bare-repository"], 16);
          const partialClone = await inspect(
            ["-C", cache, "config", "--get", "extensions.partialClone"],
            64,
          );
          const remoteUrl = await inspect(
            ["-C", cache, "config", "--get", "remote.origin.url"],
            8 * 1024,
          );
          const promisor = await inspect(
            ["-C", cache, "config", "--get", "remote.origin.promisor"],
            16,
          );
          const filter = await inspect(
            ["-C", cache, "config", "--get", "remote.origin.partialclonefilter"],
            64,
          );
          valid =
            bare === "true" &&
            partialClone === "origin" &&
            normalizedRepositoryUrl(remoteUrl) === normalizedRepoUrl &&
            promisor === "true" &&
            filter === "blob:none";
        } catch {
          valid = false;
        }
        if (!valid) rmSync(cache, { recursive: true, force: true });
      }
      if (!existsSync(cache)) {
        const initializing = mkdtempSync(join(options.cacheRoot, `.init-${key}-`));
        try {
          await run(["init", "--bare", initializing]);
          await run(["-C", initializing, "config", "extensions.partialClone", "origin"]);
          await run(["-C", initializing, "config", "remote.origin.url", locator.repoUrl]);
          await run(["-C", initializing, "config", "remote.origin.promisor", "true"]);
          await run([
            "-C",
            initializing,
            "config",
            "remote.origin.partialclonefilter",
            "blob:none",
          ]);
          try {
            renameSync(initializing, cache);
          } catch (error: unknown) {
            if (!existsSync(cache)) throw error;
            rmSync(initializing, { recursive: true, force: true });
          }
        } finally {
          if (existsSync(initializing)) rmSync(initializing, { recursive: true, force: true });
        }
      }

      const requested =
        locator.revision.mode === "track" ? locator.revision.ref : locator.revision.commit;
      const fetchArgs = [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-C",
        cache,
        "fetch",
        "--filter=blob:none",
        "--no-tags",
        "--depth=1",
        locator.repoUrl,
        requested,
      ] as const;
      let fetchResult: GitProcessResult;
      try {
        fetchResult = await git.run(fetchArgs, {
          env: { ...daemonEnv, GIT_ALLOW_PROTOCOL: "https" },
          timeoutMs: remainingMs(),
        });
      } catch (error) {
        if (error instanceof GitProcessFailure && partialFilterUnsupported(error.result.stderr)) {
          rmSync(cache, { recursive: true, force: true });
        }
        throw mapGitFailure(error, "fetch");
      }
      if (partialFilterUnsupported(fetchResult.stderr)) {
        rmSync(cache, { recursive: true, force: true });
        throw new GitAcquireError(
          "auth_or_repository_unavailable",
          "repository does not support bounded partial fetch",
        );
      }

      const resolvedCommit = text(
        (await run(["-C", cache, "rev-parse", "FETCH_HEAD^{commit}"], "other", 64)).stdout,
      );
      if (!/^[0-9a-f]{40}$/.test(resolvedCommit)) {
        throw new GitAcquireError("io", "git returned an invalid resolved commit");
      }
      if (locator.revision.mode === "pin" && locator.revision.commit !== resolvedCommit) {
        throw new GitAcquireError("missing_ref", "requested pinned commit did not resolve exactly");
      }

      const selectedObject =
        locator.subpath === "."
          ? `${resolvedCommit}^{tree}`
          : `${resolvedCommit}:${locator.subpath}`;
      const selectedType = text(
        (await run(["-C", cache, "cat-file", "-t", selectedObject], "subpath", 16, true)).stdout,
      );
      if (selectedType !== "tree") {
        throw new GitAcquireError("invalid_subpath", "selected subpath is not a directory");
      }
      const treeIdentity = text(
        (await run(["-C", cache, "rev-parse", selectedObject], "subpath", 64)).stdout,
      );
      if (!/^[0-9a-f]{40}$/.test(treeIdentity)) {
        throw new GitAcquireError("io", "git returned an invalid tree identity");
      }

      remainingMs();
      stage = createOwnedMirrorStage(options.tmpRoot);
      await materializeRawTree(git, cache, treeIdentity, stage, limits, deadlineMs, daemonEnv);
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
      const cleanup = commitStagedMirror(destination, stage, provenance);
      stage = undefined;
      cleanup();
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
      throw new GitAcquireError("io", "git acquisition filesystem operation failed");
    }
  });
}
