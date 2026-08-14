// Per-Source freshness builder (#33) — a PLAIN (non-Effect) kit module, so both
// the Kit service's `state()` and the stateless `onboardSource` helper build the
// same `SourceSyncStatus` shape from one definition. Kept OFF the Context.Service
// module (kit-live.ts) so the onboard edge does not import the Kit service.

import type { Source, SourceSyncStatus } from "@hive/contract";
import type { SyncFailureReason } from "./effect/errors.ts";
import { readProvenance } from "./mirror.ts";

// The last sync error for a Source, surfaced in its freshness state. `reason`
// stays on the typed channel (the wire `errorReason` is free-form, but the
// in-process branch is a checked discriminant).
export type LastSyncError = {
  reason: SyncFailureReason;
  detail?: string;
  rateLimitReset?: number;
};

// Build one Source's freshness status. A failed/rate-limited check is surfaced
// distinctly and never reports "up to date". `origin` is read live from the
// passed Source entry, not a cached value.
export function buildSourceSyncStatus(
  source: Source,
  mirrorRoot: string,
  lastError: LastSyncError | undefined,
): SourceSyncStatus {
  const base = { sourceId: source.id, origin: source.origin };
  // A local (bundled) Source short-circuits BEFORE readProvenance: a local mirror
  // writes no provenance file, so falling through would mis-report a CLEAN local
  // sync as `check_failed`. But a local sync can still FAIL (a bad
  // HIVE_STARTER_ROOT / packaging miss → missing_starter_root): when an error is
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
  const prov = readProvenance(mirrorRoot);
  if (lastError) {
    return {
      ...base,
      state: lastError.reason === "rate_limited" ? "rate_limited" : "check_failed",
      sha: prov?.sha ?? null,
      fetchedAt: prov?.fetchedAt ?? null,
      errorReason: lastError.reason,
      ...(lastError.detail ? { errorDetail: lastError.detail } : {}),
      ...(lastError.rateLimitReset !== undefined
        ? { rateLimitReset: lastError.rateLimitReset }
        : {}),
    };
  }
  return {
    ...base,
    state: prov ? "up_to_date" : "check_failed",
    sha: prov?.sha ?? null,
    fetchedAt: prov?.fetchedAt ?? null,
    ...(prov ? {} : { errorReason: "no_mirror" }),
  };
}
