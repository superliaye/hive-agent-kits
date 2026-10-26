// Per-Source freshness builder — a PLAIN (non-Effect) kit module, so both
// the Kit service's `state()` and the stateless `onboardSource` helper build the
// same `SourceSyncStatus` shape from one definition. Kept OFF the Context.Service
// module (kit-live.ts) so the onboard edge does not import the Kit service.

import type { Source, SourceSyncStatus } from "@hive/contract";
import type { SyncFailureReason } from "./effect/errors.ts";
import { type MirrorRecord, readMirrorRecord } from "./mirror.ts";

// The last sync error for a Source, surfaced in its freshness state. `reason`
// stays on the typed channel (the wire `errorReason` is free-form, but the
// in-process branch is a checked discriminant).
export type LastSyncError = {
  reason: SyncFailureReason;
  detail?: string;
  rateLimitReset?: number;
};

function recordedCommit(record: MirrorRecord): string | null {
  const { origin } = record;
  switch (origin.transport) {
    case "git":
    case "tarball":
      return origin.resolvedCommit;
    case "working-tree":
      return origin.head;
    case "bundled":
      return null;
  }
}

// Build one Source's freshness status. A failed/rate-limited check is surfaced
// distinctly and never reports "up to date".
export function buildSourceSyncStatus(
  source: Source,
  mirrorRoot: string,
  lastError: LastSyncError | undefined,
): SourceSyncStatus {
  const base = { sourceId: source.id };
  // A local (bundled) Source short-circuits: it has no commit to report. But a
  // local sync can still FAIL (a bad HIVE_STARTER_ROOT / packaging miss →
  // missing_starter_root): when an error is
  // recorded for it, surface `check_failed` like any other failed Source — never
  // mask a failure as the healthy `local` state. A clean local sync → `local`,
  // null sha/fetchedAt (derived from kind, never a synthetic sha).
  if (source.locator.kind === "starter") {
    if (lastError) {
      return {
        ...base,
        state: "check_failed",
        sha: null,
        fetchedAt: null,
        errorReason: lastError.reason,
        ...(lastError.detail ? { errorDetail: lastError.detail } : {}),
      };
    }
    return { ...base, state: "local", sha: null, fetchedAt: null };
  }
  const record = readMirrorRecord(mirrorRoot);
  const sha = record ? recordedCommit(record) : null;
  const fetchedAt = record?.fetchedAt ?? null;
  if (lastError) {
    return {
      ...base,
      state: lastError.reason === "rate_limited" ? "rate_limited" : "check_failed",
      sha,
      fetchedAt,
      errorReason: lastError.reason,
      ...(lastError.detail ? { errorDetail: lastError.detail } : {}),
      ...(lastError.rateLimitReset !== undefined
        ? { rateLimitReset: lastError.rateLimitReset }
        : {}),
    };
  }
  return {
    ...base,
    state: record ? "up_to_date" : "check_failed",
    sha,
    fetchedAt,
    ...(record ? {} : { errorReason: "no_mirror" }),
  };
}
