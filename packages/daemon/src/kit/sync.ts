// Sync — fetch the latest Kit tree into the Mirror.
//
// Resolve the latest SHA via the commits API, download the tarball BY FULL SHA
// (codeload .../tar.gz/<full-sha>, never /main — keeps recorded SHA and tree
// byte-identical), extract atomically into the Mirror. Typed SyncError variants
// distinguish offline / rate_limited / parse / io. Keeps last-good on any
// failure; short-circuits when the resolved SHA equals the recorded one.

import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Source } from "@hive/contract";
import { Effect } from "effect";
import { log } from "../lib/log.ts";
import { type GitProcess } from "./acquisition/git-process.ts";
import { acquireGitSource, GitAcquireError } from "./acquisition/git-source.ts";
import { acquireWorkingTree, WorkingTreeAcquireError } from "./acquisition/working-tree.ts";
import { SyncError } from "./effect/errors.ts";
import { localSourceRootFor } from "./local-source-roots.ts";
import {
  localSyncMirror,
  MissingStarterRoot,
  mirrorExists,
  readProvenance,
  writeMirror,
} from "./mirror.ts";
import type { DeployTargets } from "./targets.ts";
import type { MirrorProvenance } from "./types.ts";

// Parse a normalized https GitHub origin into owner/repo. The Source registry
// already strips a trailing `/` / `.git` and lowercases scheme+host, so we
// only validate host + extract the two path segments. Any non-GitHub host, or a
// path that isn't exactly `<owner>/<repo>`, yields `null` (the caller maps that
// to a typed parse SyncError — this slice is GitHub-only).
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
// real network. Production wires `globalThis.fetch`.
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type SyncOutcome = {
  // "synced" — a new SHA landed; "unchanged" — already at the resolved SHA.
  status: "synced" | "unchanged";
  provenance: MirrorProvenance;
};

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

// Sync one Source into its own Mirror. Derives the GitHub commits-API +
// codeload-tarball URLs from the Source origin (GitHub-only this slice; a
// non-GitHub origin is a typed parse SyncError, never a throw). Short-circuits
// when the resolved SHA matches the recorded mirror. On extraction failure the
// prior Mirror is retained (writeMirror is atomic), surfaced as a typed
// SyncError — never thrown out of the daemon.
export function syncSource(
  mirrorRoot: string,
  tmpRoot: string,
  origin: string,
  fetchImpl: HttpFetch,
): Effect.Effect<SyncOutcome, SyncError> {
  return Effect.gen(function* () {
    const parsed = parseGithubOrigin(origin);
    if (!parsed) {
      return yield* Effect.fail(
        new SyncError({ reason: "parse", message: "unsupported origin (only https GitHub)" }),
      );
    }
    const { owner, repo } = parsed;
    const commitsUrl = `https://api.github.com/repos/${owner}/${repo}/commits/main`;
    const sha = yield* resolveSha(fetchImpl, commitsUrl);
    const prior = readProvenance(mirrorRoot);
    if (prior && prior.sha === sha && mirrorExists(mirrorRoot)) {
      return { status: "unchanged", provenance: prior } as const;
    }
    const codeloadUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
    const tarBuf = yield* downloadTar(fetchImpl, codeloadUrl);
    const provenance = yield* Effect.try({
      try: () => writeMirror(mirrorRoot, tmpRoot, tarBuf, sha),
      catch: (err) =>
        new SyncError({ reason: "io", message: `mirror write failed: ${String(err)}` }),
    });
    log().info(
      { module: "kit/sync", origin, sha, fetchedAt: provenance.fetchedAt },
      "source mirror synced",
    );
    return { status: "synced", provenance } as const;
  });
}

// Sync a local (bundled) Source into its Mirror by copying the Starter content
// root — no network, no fetch, no provenance. A missing/absent `starterRoot` (bad
// override or a packaging miss) is a typed `missing_starter_root` SyncError, never
// a raw throw; any other copy/swap fault maps to `io`. Returns only a status —
// unlike `syncSource` there is no MirrorProvenance (the sync-status derives
// "local" from Source.locator.kind, never a synthetic sha). Always `synced` (re-copies
// every run — a local mirror has no sha to short-circuit on).
export function localSyncSource(
  mirrorRoot: string,
  tmpRoot: string,
  starterRoot: string,
): Effect.Effect<{ status: "synced" }, SyncError> {
  return Effect.try({
    try: () => {
      localSyncMirror(mirrorRoot, tmpRoot, starterRoot);
      return { status: "synced" } as const;
    },
    catch: (err) =>
      err instanceof MissingStarterRoot
        ? new SyncError({ reason: "missing_starter_root", message: err.message })
        : new SyncError({ reason: "io", message: `local mirror write failed: ${String(err)}` }),
  });
}

const ACQUISITION_DETAILS = {
  offline: "repository fetch failed",
  auth_or_repository_unavailable: "repository access failed",
  invalid_locator: "source locator is invalid",
  missing_ref: "requested revision is unavailable",
  invalid_subpath: "selected subpath is unavailable",
  timeout: "source acquisition timed out",
  budget_exceeded: "selected tree exceeds acquisition limits",
  unsafe_tree: "selected tree is unsafe",
  working_tree_not_allowed: "working tree is not allowed",
  working_tree_changed: "working tree changed during capture",
  io: "source acquisition failed",
} as const;

function acquisitionSyncError(error: unknown): SyncError {
  if (error instanceof GitAcquireError || error instanceof WorkingTreeAcquireError) {
    const detail = ACQUISITION_DETAILS[error.code];
    return new SyncError({ reason: error.code, message: detail, detail });
  }
  return new SyncError({
    reason: "io",
    message: ACQUISITION_DETAILS.io,
    detail: ACQUISITION_DETAILS.io,
  });
}

// Transport dispatch for persisted Sources. The locator is authoritative: the
// legacy `origin` and `kind` fields are display-only compatibility data. Each
// acquisition writes directly to the Source-id scoped mirror through its atomic
// stage/swap implementation, so an error leaves the exact prior provenance and
// tree intact.
export function syncLocatorSource(
  source: Source,
  targets: DeployTargets,
  options: LocatorSyncOptions = {},
): Effect.Effect<{ status: "synced" }, SyncError> {
  const mirrorRoot = targets.mirrorRoot(source.id);
  const locator = source.locator;
  switch (locator.kind) {
    case "starter": {
      const root = localSourceRootFor(source, targets);
      return root
        ? localSyncSource(mirrorRoot, targets.kitTmpRoot(), root)
        : Effect.fail(
            new SyncError({
              reason: "missing_starter_root",
              message: "starter content root is unavailable",
              detail: "starter content root is unavailable",
            }),
          );
    }
    case "git":
      if (
        options.legacyGithubFixtureFetch &&
        parseGithubOrigin(locator.repoUrl) !== null &&
        locator.revision.mode === "track" &&
        locator.revision.ref === "refs/heads/main" &&
        locator.subpath === "."
      ) {
        return syncSource(
          mirrorRoot,
          targets.kitTmpRoot(),
          locator.repoUrl,
          options.legacyGithubFixtureFetch,
        ).pipe(Effect.map(() => ({ status: "synced" }) as const));
      }
      return Effect.tryPromise({
        try: async () => {
          await acquireGitSource(locator, mirrorRoot, {
            cacheRoot: join(dirname(targets.kitTmpRoot()), "git-cache"),
            tmpRoot: targets.kitTmpRoot(),
            ...(options.gitProcess ? { process: options.gitProcess } : {}),
          });
          return { status: "synced" } as const;
        },
        catch: acquisitionSyncError,
      });
    case "working-tree":
      return Effect.tryPromise({
        try: async () => {
          await acquireWorkingTree(locator, mirrorRoot, {
            allowedRoots: options.workingTreeRoots ?? [],
            tmpRoot: targets.kitTmpRoot(),
            ...(options.gitProcess ? { process: options.gitProcess } : {}),
          });
          return { status: "synced" } as const;
        },
        catch: acquisitionSyncError,
      });
  }
}

export function productionFetch(): HttpFetch {
  return (url, init) => fetch(url, init);
}
