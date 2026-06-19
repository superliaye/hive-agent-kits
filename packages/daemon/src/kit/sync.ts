// Sync — fetch the latest Kit tree into the Mirror (Plan A1).
//
// Resolve the latest SHA via the commits API, download the tarball BY FULL SHA
// (codeload .../tar.gz/<full-sha>, never /main — keeps recorded SHA and tree
// byte-identical), extract atomically into the Mirror. Typed SyncError variants
// distinguish offline / rate_limited / parse / io. Keeps last-good on any
// failure; short-circuits when the resolved SHA equals the recorded one.

import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { Effect } from "effect";
import { log } from "../lib/log.ts";
import { SyncError } from "./effect/errors.ts";
import { mirrorExists, readProvenance, writeMirror } from "./mirror.ts";
import type { DeployTargets } from "./targets.ts";
import type { MirrorProvenance } from "./types.ts";

const REPO = "superliaye/my-agent-kits";
const COMMITS_URL = `https://api.github.com/repos/${REPO}/commits/main`;
const codeloadUrl = (sha: string) => `https://codeload.github.com/${REPO}/tar.gz/${sha}`;

// Injectable HTTP port so tests drive offline / 403 / fixture-tarball without
// real network. Production wires `globalThis.fetch`.
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type SyncOutcome = {
  // "synced" — a new SHA landed; "unchanged" — already at the resolved SHA.
  status: "synced" | "unchanged";
  provenance: MirrorProvenance;
};

const SHA_RE = /^[0-9a-f]{40}$/;

// Resolve main's full 40-hex SHA. 403 → rate_limited (surface X-RateLimit-Reset);
// network throw → offline; bad body → parse.
function resolveSha(fetchImpl: HttpFetch): Effect.Effect<string, SyncError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetchImpl(COMMITS_URL, {
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

function downloadTar(fetchImpl: HttpFetch, sha: string): Effect.Effect<Uint8Array, SyncError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetchImpl(codeloadUrl(sha), {
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

// Run a full sync. Short-circuits when the resolved SHA matches the recorded
// mirror. On extraction failure the prior mirror is retained (writeMirror is
// atomic), surfaced as a typed SyncError — never thrown out of the daemon.
export function runSync(
  targets: DeployTargets,
  fetchImpl: HttpFetch,
): Effect.Effect<SyncOutcome, SyncError> {
  return Effect.gen(function* () {
    const sha = yield* resolveSha(fetchImpl);
    const prior = readProvenance(targets);
    if (prior && prior.sha === sha && mirrorExists(targets)) {
      return { status: "unchanged", provenance: prior } as const;
    }
    const tarBuf = yield* downloadTar(fetchImpl, sha);
    const provenance = yield* Effect.try({
      try: () => writeMirror(targets, tarBuf, sha),
      catch: (err) =>
        new SyncError({ reason: "io", message: `mirror write failed: ${String(err)}` }),
    });
    log().info({ module: "kit/sync", sha, fetchedAt: provenance.fetchedAt }, "kit mirror synced");
    return { status: "synced", provenance } as const;
  });
}

export function productionFetch(): HttpFetch {
  return (url, init) => fetch(url, init);
}
