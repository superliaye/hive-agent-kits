import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SourceLocator } from "@hive/contract";
import { Effect, Exit, type Scope } from "effect";
import { log } from "../../lib/log.ts";
import type { SyncError } from "../effect/errors.ts";
import {
  type GitProcess,
  GitProcessFailure,
  type GitProcessResult,
  productionGitProcess,
} from "./git-process.ts";
import {
  type AcquisitionCode,
  acquisitionError,
  type ListedEntry,
  resolveListing,
  type TreePath,
  type TreeSnapshot,
} from "./snapshot.ts";
import type { TreeLimits } from "./tree-guard.ts";

type GitLocator = Extract<SourceLocator, { kind: "git" }>;

class GitAcquireError extends Error {
  override readonly name = "GitAcquireError";
  constructor(
    readonly code: AcquisitionCode,
    message: string,
  ) {
    super(message);
  }
}

type GitSnapshotOptions = {
  cacheRoot: string;
  process?: GitProcess;
  limits: TreeLimits;
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

async function acquireRepositoryLock(key: string): Promise<() => void> {
  const prior = repositoryLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const queued = prior.then(() => current);
  repositoryLocks.set(key, queued);
  await prior;
  return () => {
    release();
    if (repositoryLocks.get(key) === queued) repositoryLocks.delete(key);
  };
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

function syncErrorOf(error: unknown): SyncError {
  return acquisitionError(error instanceof GitAcquireError ? error.code : "io");
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

function assertSafeTreePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new GitAcquireError("unsafe_tree", "git tree contains an unsafe path");
  }
}

// A null object is one the cache lacks; only a read with lazy fetching off
// reports one.
function parseBatchObjects(
  output: Uint8Array,
  expectedIds: readonly string[],
): (Uint8Array | null)[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const objects: (Uint8Array | null)[] = [];
  let offset = 0;
  for (const expectedId of expectedIds) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new GitAcquireError("io", "git blob batch response is incomplete");
    const header = decoder.decode(output.subarray(offset, newline));
    if (header === `${expectedId} missing`) {
      objects.push(null);
      offset = newline + 1;
      continue;
    }
    const parsed = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header);
    if (!parsed || parsed[1] !== expectedId) {
      throw new GitAcquireError("io", "git blob batch response is invalid");
    }
    const size = Number(parsed[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitAcquireError("io", "git blob batch response has an invalid size");
    }
    const dataStart = newline + 1;
    const dataEnd = dataStart + size;
    if (dataEnd >= output.length || output[dataEnd] !== 10) {
      throw new GitAcquireError("io", "git blob batch response is truncated");
    }
    objects.push(output.slice(dataStart, dataEnd));
    offset = dataEnd + 1;
  }
  if (offset !== output.length) {
    throw new GitAcquireError("io", "git blob batch response has trailing data");
  }
  return objects;
}

const BATCH_SIZE = 128;

type GitBlob = { path: TreePath; objectId: string };

// One repository's bare partial-clone cache under one acquisition deadline and
// byte budget. Only the blobs that are read cross the network.
class GitCache {
  private bytesRead = 0;
  private readonly cache: string;

  constructor(
    private readonly git: GitProcess,
    private readonly cacheRoot: string,
    private readonly key: string,
    private readonly limits: TreeLimits,
    private readonly deadlineMs: number,
    private readonly daemonEnv: NodeJS.ProcessEnv,
    private readonly repoUrl: string,
  ) {
    this.cache = join(cacheRoot, key);
  }

  private remainingMs(): number {
    const remaining = this.deadlineMs - Date.now();
    if (remaining <= 0) throw new GitAcquireError("timeout", "git acquisition timed out");
    return remaining;
  }

  private async run(
    args: readonly string[],
    phase: GitPhase = "other",
    maxStdoutBytes?: number,
    networkCapable = false,
  ): Promise<GitProcessResult> {
    try {
      return await this.git.run(networkCapable ? httpsOnly(args) : args, {
        env: networkCapable ? httpsOnlyEnv(this.daemonEnv) : this.daemonEnv,
        timeoutMs: this.remainingMs(),
        ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
      });
    } catch (error) {
      throw mapGitFailure(error, phase);
    }
  }

  private async ensureCache(locator: GitLocator, normalizedRepoUrl: string): Promise<void> {
    const cache = this.cache;
    mkdirSync(this.cacheRoot, { recursive: true });
    if (existsSync(cache)) {
      let valid = false;
      try {
        const inspect = async (args: readonly string[], maxStdoutBytes: number) =>
          text(
            (
              await this.git.run(args, {
                env: this.daemonEnv,
                timeoutMs: this.remainingMs(),
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
    if (existsSync(cache)) return;
    const initializing = mkdtempSync(join(this.cacheRoot, `.init-${this.key}-`));
    try {
      await this.run(["init", "--bare", initializing]);
      await this.run(["-C", initializing, "config", "extensions.partialClone", "origin"]);
      await this.run(["-C", initializing, "config", "remote.origin.url", locator.repoUrl]);
      await this.run(["-C", initializing, "config", "remote.origin.promisor", "true"]);
      await this.run([
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

  async fetch(
    locator: GitLocator,
    normalizedRepoUrl: string,
  ): Promise<{ resolvedCommit: string; treeIdentity: string }> {
    await this.ensureCache(locator, normalizedRepoUrl);
    const { cache } = this;
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
      fetchResult = await this.git.run(fetchArgs, {
        env: { ...this.daemonEnv, GIT_ALLOW_PROTOCOL: "https" },
        timeoutMs: this.remainingMs(),
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
      (await this.run(["-C", cache, "rev-parse", "FETCH_HEAD^{commit}"], "other", 64)).stdout,
    );
    if (!/^[0-9a-f]{40}$/.test(resolvedCommit)) {
      throw new GitAcquireError("io", "git returned an invalid resolved commit");
    }
    if (locator.revision.mode === "pin" && locator.revision.commit !== resolvedCommit) {
      throw new GitAcquireError("missing_ref", "requested pinned commit did not resolve exactly");
    }

    const selectedObject =
      locator.subpath === "." ? `${resolvedCommit}^{tree}` : `${resolvedCommit}:${locator.subpath}`;
    const selectedType = text(
      (await this.run(["-C", cache, "cat-file", "-t", selectedObject], "subpath", 16, true)).stdout,
    );
    if (selectedType !== "tree") {
      throw new GitAcquireError("invalid_subpath", "selected subpath is not a directory");
    }
    const treeIdentity = text(
      (await this.run(["-C", cache, "rev-parse", selectedObject], "subpath", 64)).stdout,
    );
    if (!/^[0-9a-f]{40}$/.test(treeIdentity)) {
      throw new GitAcquireError("io", "git returned an invalid tree identity");
    }
    return { resolvedCommit, treeIdentity };
  }

  // `ls-tree -r` lists the blobless tree without fetching a blob; only link
  // targets are read here, so links can be resolved against the listing.
  async list(treeIdentity: string): Promise<{
    listed: Map<TreePath, ListedEntry>;
    objectIds: Map<TreePath, string>;
  }> {
    const metadataLimit = Math.max(
      1,
      Math.min(128 * 1024 * 1024, this.limits.maxListedEntries * 8192),
    );
    const listing = (
      await this.run(
        ["-C", this.cache, "ls-tree", "-r", "-z", treeIdentity],
        "other",
        metadataLimit,
      )
    ).stdout;
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(listing);
    } catch {
      throw new GitAcquireError("unsafe_tree", "git tree contains a non-UTF-8 path");
    }
    const records = decoded.split("\0");
    if (records.at(-1) === "") records.pop();
    if (records.length > this.limits.maxListedEntries) {
      throw new GitAcquireError("budget_exceeded", "selected tree exceeds listing limit");
    }
    const listed = new Map<TreePath, ListedEntry>();
    const objectIds = new Map<TreePath, string>();
    const links: GitBlob[] = [];
    for (const record of records) {
      this.remainingMs();
      const tab = record.indexOf("\t");
      const match = /^(100644|100755|120000) blob ([0-9a-f]{40})$/.exec(
        tab < 0 ? "" : record.slice(0, tab),
      );
      if (!match || tab < 0) {
        throw new GitAcquireError("unsafe_tree", "git tree contains an unsupported entry");
      }
      const raw = record.slice(tab + 1);
      assertSafeTreePath(raw);
      const path = raw as TreePath;
      if (objectIds.has(path)) {
        throw new GitAcquireError("unsafe_tree", "git tree contains duplicate paths");
      }
      const objectId = match[2];
      if (!objectId) throw new GitAcquireError("io", "git tree entry is incomplete");
      objectIds.set(path, objectId);
      if (match[1] === "120000") links.push({ path, objectId });
      else listed.set(path, { mode: match[1] === "100755" ? "exec" : "file" });
    }
    const sortedPaths = [...objectIds.keys()].sort();
    for (let index = 1; index < sortedPaths.length; index++) {
      const prior = sortedPaths[index - 1];
      const current = sortedPaths[index];
      if (prior && current?.startsWith(`${prior}/`)) {
        throw new GitAcquireError("unsafe_tree", "git tree contains conflicting paths");
      }
    }
    const targets = await this.readBlobs(links);
    for (const link of links) {
      let target: string;
      try {
        target = new TextDecoder("utf-8", { fatal: true }).decode(targets.get(link.path));
      } catch {
        throw new GitAcquireError("unsafe_tree", "git tree link target is invalid");
      }
      listed.set(link.path, { mode: "link", text: target });
    }
    return { listed, objectIds };
  }

  // A lazy fetch costs one network round trip per missing blob, so each batch
  // reads with lazy fetching off and then fetches what it lacks in one request.
  // A single missing blob costs one round trip either way and is left to the
  // lazy fetch. Git without GIT_NO_LAZY_FETCH (before 2.44) fetches lazily.
  async readBlobs(blobs: readonly GitBlob[]): Promise<Map<TreePath, Uint8Array>> {
    const out = new Map<TreePath, Uint8Array>();
    for (let start = 0; start < blobs.length; start += BATCH_SIZE) {
      const group = blobs.slice(start, start + BATCH_SIZE);
      const objectIds = group.map((blob) => blob.objectId);
      const local = await this.catFile(objectIds, false);
      const missing = [...new Set(objectIds.filter((_, index) => local[index] === null))];
      let fetched = new Map<string, Uint8Array | null>();
      if (missing.length > 0) {
        if (missing.length > 1) await this.fetchBlobs(missing);
        const data = await this.catFile(missing, true);
        fetched = new Map(missing.map((objectId, index) => [objectId, data[index] ?? null]));
      }
      for (let index = 0; index < group.length; index++) {
        const blob = group[index];
        const content = local[index] ?? (blob ? fetched.get(blob.objectId) : null);
        if (!blob || !content) throw new GitAcquireError("io", "git blob batch is incomplete");
        out.set(blob.path, content);
      }
    }
    return out;
  }

  private async catFile(
    objectIds: readonly string[],
    lazyFetch: boolean,
  ): Promise<(Uint8Array | null)[]> {
    const networkSafeEnv = httpsOnlyEnv(this.daemonEnv);
    let batch: Uint8Array;
    try {
      batch = (
        await this.git.run(httpsOnly(["-C", this.cache, "cat-file", "--batch"]), {
          env: lazyFetch ? networkSafeEnv : { ...networkSafeEnv, GIT_NO_LAZY_FETCH: "1" },
          timeoutMs: this.remainingMs(),
          maxStdoutBytes: Math.max(
            1,
            this.limits.maxBytes - this.bytesRead + objectIds.length * 96,
          ),
          stdin: new TextEncoder().encode(`${objectIds.join("\n")}\n`),
        })
      ).stdout;
    } catch (error) {
      throw mapGitFailure(error, "other");
    }
    const objects = parseBatchObjects(batch, objectIds);
    for (const content of objects) {
      this.bytesRead += content?.byteLength ?? 0;
      if (this.bytesRead > this.limits.maxBytes) {
        throw new GitAcquireError("budget_exceeded", "selected tree exceeds byte limit");
      }
    }
    return objects;
  }

  // The request Git's own lazy fetch makes, for many blobs at once.
  private async fetchBlobs(objectIds: readonly string[]): Promise<void> {
    try {
      await this.git.run(
        httpsOnly([
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "-C",
          this.cache,
          "fetch",
          "--filter=blob:none",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--stdin",
          this.repoUrl,
        ]),
        {
          env: httpsOnlyEnv(this.daemonEnv),
          timeoutMs: this.remainingMs(),
          stdin: new TextEncoder().encode(`${objectIds.join("\n")}\n`),
        },
      );
    } catch (error) {
      throw mapGitFailure(error, "other");
    }
  }
}

// Fetches the requested commit into the per-repository partial-clone cache and
// lists the selected tree. The repository lock is held until the scope closes;
// after an interruption (an add that outran its budget) it is held until the
// abandoned Git call settles, so a later Sync never moves the cache under it.
export function gitSnapshot(
  locator: GitLocator,
  options: GitSnapshotOptions,
): Effect.Effect<TreeSnapshot, SyncError, Scope.Scope> {
  return Effect.gen(function* () {
    const normalizedRepoUrl = normalizedRepositoryUrl(locator.repoUrl);
    if (!normalizedRepoUrl) return yield* Effect.fail(acquisitionError("invalid_locator"));
    if (!safeSubpath(locator.subpath)) {
      return yield* Effect.fail(acquisitionError("invalid_subpath"));
    }
    const key = cacheKey(normalizedRepoUrl);
    let inFlight: Promise<unknown> = Promise.resolve();
    const tracked = <T>(work: () => Promise<T>) =>
      Effect.tryPromise({
        try: () => {
          const running = work();
          inFlight = running.catch(() => undefined);
          return running;
        },
        catch: syncErrorOf,
      });
    yield* Effect.acquireRelease(
      Effect.promise(() => acquireRepositoryLock(key)),
      (release, exit) =>
        Effect.sync(() => {
          if (!Exit.hasInterrupts(exit)) return release();
          inFlight
            .then(release)
            .catch((err: unknown) =>
              log().warn(
                { module: "kit/git-source", err: String(err) },
                "repository lock release failed",
              ),
            );
        }),
    );
    const cache = new GitCache(
      options.process ?? productionGitProcess(),
      options.cacheRoot,
      key,
      options.limits,
      Date.now() + options.limits.timeoutMs,
      { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      locator.repoUrl,
    );
    const opened = yield* tracked(async () => {
      const fetched = await cache.fetch(locator, normalizedRepoUrl);
      return { ...fetched, ...(await cache.list(fetched.treeIdentity)) };
    });
    return {
      origin: {
        transport: "git",
        repoUrl: locator.repoUrl,
        requestedRevision: locator.revision,
        resolvedCommit: opened.resolvedCommit,
        subpath: locator.subpath,
        treeIdentity: opened.treeIdentity,
      },
      entries: resolveListing(opened.listed),
      read: (paths) =>
        tracked(async () =>
          cache.readBlobs(
            paths.map((path) => {
              const objectId = opened.objectIds.get(path);
              if (!objectId || opened.listed.get(path)?.mode === "link") {
                throw new GitAcquireError("io", "git tree entry is unavailable");
              }
              return { path, objectId };
            }),
          ),
        ),
      confirm: () => Effect.void,
    } satisfies TreeSnapshot;
  });
}
