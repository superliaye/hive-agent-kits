// Sync — the one path that turns any Source into its Mirror: open a listed
// snapshot of the Source tree, recognize it with a Recipe, materialize only what
// the Recipe projects, confirm the snapshot held still, and swap the Mirror in.
// Any failure keeps the last good Mirror; re-syncing an unchanged tree writes a
// byte-identical Mirror with the same identity.

import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Source } from "@hive/contract";
import { Effect, type Scope } from "effect";
import { log } from "../lib/log.ts";
import type { GitProcess } from "./acquisition/git-process.ts";
import { gitSnapshot } from "./acquisition/git-source.ts";
import {
  directorySnapshot,
  missingStarterRoot,
  type TreeSnapshot,
  tarSnapshot,
} from "./acquisition/snapshot.ts";
import { DEFAULT_TREE_LIMITS } from "./acquisition/tree-guard.ts";
import { workingTreeSnapshot } from "./acquisition/working-tree.ts";
import { SyncError } from "./effect/errors.ts";
import { localSourceRootFor } from "./local-source-roots.ts";
import { commitMirror, materialize } from "./mirror.ts";
import { recipeTree, recognizeSource } from "./recipes/recipe.ts";
import { tileForLocator } from "./recipes/tiles.ts";
import type { DeployTargets } from "./targets.ts";

// Parse a normalized https GitHub origin into owner/repo. The Source registry
// already strips a trailing `/` / `.git` and lowercases scheme+host, so we
// only validate host + extract the two path segments. Any non-GitHub host, or a
// path that isn't exactly `<owner>/<repo>`, yields `null`, and the locator takes
// the Git path even when the HTTP fixture is installed.
export function parseGithubOrigin(origin: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) return null;
  const [owner, rawRepo] = segments;
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!repo) return null;
  return { owner, repo };
}

// Injectable HTTP port so tests drive offline / 403 / fixture-tarball without
// real network.
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type LocatorSyncOptions = {
  // The daemon-owned Git process port. Production leaves this undefined and
  // acquires the real bounded process; tests may inject a hermetic process.
  gitProcess?: GitProcess;
  // Configured at the composition root, read at sync time so config reloads are
  // honored without a Hive-specific working-tree policy in this module.
  workingTreeRoots?: readonly string[];
  // Compatibility-only GitHub HTTP fixture port. Production leaves this unset
  // and uses the dedicated Git process path below.
  legacyGithubFixtureFetch?: HttpFetch;
};

const SHA_RE = /^[0-9a-f]{40}$/;

// Resolve main's full 40-hex SHA. 403 → rate_limited (surface X-RateLimit-Reset);
// network throw → offline; bad body → parse.
function resolveSha(fetchImpl: HttpFetch, commitsUrl: string): Effect.Effect<string, SyncError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetchImpl(commitsUrl, {
        headers: { accept: "application/vnd.github+json", "user-agent": "hive-kit-sync" },
      });
      if (res.status === 403) {
        const resetHdr = res.headers.get("x-ratelimit-reset");
        const reset = resetHdr ? Number(resetHdr) : undefined;
        throw new SyncError({
          reason: "rate_limited",
          message: "GitHub commits API rate-limited (HTTP 403)",
          ...(reset !== undefined && Number.isFinite(reset) ? { rateLimitReset: reset } : {}),
        });
      }
      if (!res.ok) {
        throw new SyncError({ reason: "io", message: `commits API HTTP ${res.status}` });
      }
      const body = (await res.json()) as { sha?: unknown };
      if (typeof body.sha !== "string" || !SHA_RE.test(body.sha)) {
        throw new SyncError({ reason: "parse", message: "commits API returned no 40-hex sha" });
      }
      return body.sha;
    },
    catch: (err) => (err instanceof SyncError ? err : offlineFrom(err)),
  });
}

function offlineFrom(err: unknown): SyncError {
  return new SyncError({ reason: "offline", message: `network unreachable: ${String(err)}` });
}

function downloadTar(
  fetchImpl: HttpFetch,
  codeloadUrl: string,
): Effect.Effect<Uint8Array, SyncError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetchImpl(codeloadUrl, {
        headers: { "user-agent": "hive-kit-sync" },
      });
      if (res.status === 403) {
        const resetHdr = res.headers.get("x-ratelimit-reset");
        const reset = resetHdr ? Number(resetHdr) : undefined;
        throw new SyncError({
          reason: "rate_limited",
          message: "codeload rate-limited (HTTP 403)",
          ...(reset !== undefined && Number.isFinite(reset) ? { rateLimitReset: reset } : {}),
        });
      }
      if (!res.ok) {
        throw new SyncError({ reason: "io", message: `codeload HTTP ${res.status}` });
      }
      const gz = new Uint8Array(await res.arrayBuffer());
      try {
        return new Uint8Array(gunzipSync(Buffer.from(gz)));
      } catch (e) {
        throw new SyncError({ reason: "parse", message: `tarball gunzip failed: ${String(e)}` });
      }
    },
    catch: (err) => (err instanceof SyncError ? err : offlineFrom(err)),
  });
}

// The memory-mode fixture: resolve main's SHA, then download the codeload
// tarball BY FULL SHA (never /main), so the recorded commit and the tree match.
function legacyGithubSnapshot(
  owner: string,
  repo: string,
  repoUrl: string,
  fetchImpl: HttpFetch,
): Effect.Effect<TreeSnapshot, SyncError> {
  return Effect.gen(function* () {
    const sha = yield* resolveSha(
      fetchImpl,
      `https://api.github.com/repos/${owner}/${repo}/commits/main`,
    );
    const tar = yield* downloadTar(
      fetchImpl,
      `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`,
    );
    return yield* tarSnapshot(tar, repoUrl, sha);
  });
}

function openSnapshot(
  source: Source,
  targets: DeployTargets,
  options: LocatorSyncOptions,
): Effect.Effect<TreeSnapshot, SyncError, Scope.Scope> {
  const locator = source.locator;
  switch (locator.kind) {
    case "starter": {
      const root = localSourceRootFor(source, targets);
      return root ? directorySnapshot(root) : Effect.fail(missingStarterRoot());
    }
    case "git": {
      const github = parseGithubOrigin(locator.repoUrl);
      if (
        options.legacyGithubFixtureFetch &&
        github !== null &&
        locator.revision.mode === "track" &&
        locator.revision.ref === "refs/heads/main" &&
        locator.subpath === "."
      ) {
        return legacyGithubSnapshot(
          github.owner,
          github.repo,
          locator.repoUrl,
          options.legacyGithubFixtureFetch,
        );
      }
      return gitSnapshot(locator, {
        cacheRoot: join(dirname(targets.kitTmpRoot()), "git-cache"),
        limits: DEFAULT_TREE_LIMITS,
        ...(options.gitProcess ? { process: options.gitProcess } : {}),
      });
    }
    case "working-tree":
      return workingTreeSnapshot(locator, {
        allowedRoots: options.workingTreeRoots ?? [],
        limits: DEFAULT_TREE_LIMITS,
        ...(options.gitProcess ? { process: options.gitProcess } : {}),
      });
  }
}

// The locator is the transport authority; the legacy `origin` and `kind` fields
// are display-only compatibility data. A working tree that changed under the
// capture is re-captured once from a fresh snapshot.
export function syncLocatorSource(
  source: Source,
  targets: DeployTargets,
  options: LocatorSyncOptions = {},
): Effect.Effect<{ status: "synced" | "unchanged" }, SyncError> {
  const once = Effect.scoped(
    Effect.gen(function* () {
      const snapshot = yield* openSnapshot(source, targets, options);
      const recognition = yield* recognizeSource(
        recipeTree(snapshot, DEFAULT_TREE_LIMITS),
        tileForLocator(source.locator),
      );
      const staged = yield* materialize(
        snapshot,
        recognition,
        targets.kitTmpRoot(),
        DEFAULT_TREE_LIMITS,
      );
      yield* snapshot.confirm();
      const outcome = yield* commitMirror(targets.mirrorRoot(source.id), staged);
      log().info(
        { module: "kit/sync", sourceId: source.id, recipe: recognition.recipe.id, ...outcome },
        "source mirror synced",
      );
      return outcome;
    }),
  );
  return once.pipe(
    Effect.retry({ times: 1, while: (error) => error.reason === "working_tree_changed" }),
  );
}
