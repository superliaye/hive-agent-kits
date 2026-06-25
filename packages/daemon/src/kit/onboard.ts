// Stateless add → sync → validate helper (#33). The app/server EDGE sequences a
// Source add: the route keeps `registry.add`, then calls THIS helper, which only
// syncs + validates the Source's Mirror and NEVER touches the registry — the
// Kit→Sources arrow stays intact (ADR-0023; grill Q1=A).
//
// Never rejects (error channel `never`): a sync failure folds into the report's
// `sync` field (Q2 keep-the-Source) and a validation failure into `validation`
// (Q3 keep + report). The 201 body carries the full outcome.
//
// Snapshot divergence (intentional): the `sync` here is a POINT-IN-TIME snapshot
// from this helper's own sync. A later GET /api/kit/state re-derives freshness
// from disk and — for a failed add where NO Mirror was built — reports
// errorReason:"no_mirror" rather than this add-time reason (e.g. "offline"). Both
// indicate failure. This helper deliberately does NOT write into the Kit service's
// private lastSyncError map (that would re-couple the edge to Kit's mutable state).

import type { ConformanceError } from "@hive/capability-schema";
import { enumerateLeaves, validate } from "@hive/capability-schema-tools";
import { capabilitiesRoot } from "@hive/capability-schema-tools/node";
import type { AddSourceResult, Source, SourceSyncStatus } from "@hive/contract";
import { Effect } from "effect";
import { SyncError } from "./effect/errors.ts";
import type { HttpFetch } from "./sync.ts";
import { syncSource } from "./sync.ts";
import { buildSourceSyncStatus, type LastSyncError } from "./sync-status.ts";
import type { DeployTargets } from "./targets.ts";

// Onboard a freshly-added Source: bounded-sync its Mirror, then validate that
// Mirror. `syncTimeoutMs` is REQUIRED (the server passes a production constant;
// tests a small value) — the bounded sync guarantees the add never hangs the
// request. git-only this slice (the add route only ever mints `git`).
export function onboardSource(
  targets: DeployTargets,
  fetchImpl: HttpFetch,
  source: Source,
  syncTimeoutMs: number,
): Effect.Effect<AddSourceResult> {
  return Effect.gen(function* () {
    const mirrorRoot = targets.mirrorRoot(source.id);

    // Bounded sync: a never-resolving fetch (or a slow one) must not hang the add.
    // On timeout the fiber is interrupted and we fold a `timeout` SyncError.
    // (Caveat: productionFetch uses bare fetch with no AbortSignal, so the
    // underlying request may linger until it settles and is discarded — acceptable;
    // threading an AbortSignal is a follow-on.)
    const syncResult = yield* Effect.result(
      syncSource(mirrorRoot, targets.kitTmpRoot(), source.origin, fetchImpl).pipe(
        Effect.timeoutOrElse({
          duration: syncTimeoutMs,
          orElse: () =>
            Effect.fail(
              new SyncError({ reason: "timeout", message: "sync exceeded the add-time budget" }),
            ),
        }),
      ),
    );

    const lastError: LastSyncError | undefined =
      syncResult._tag === "Success"
        ? undefined
        : {
            reason: syncResult.failure.reason,
            ...(syncResult.failure.rateLimitReset !== undefined
              ? { rateLimitReset: syncResult.failure.rateLimitReset }
              : {}),
          };
    const sync: SourceSyncStatus = buildSourceSyncStatus(source, mirrorRoot, lastError);

    // Validation (one tree, two reads). A failed sync on a brand-new Source leaves
    // NO Mirror dir (writeMirror is atomic — stage→swap retains last-good), so
    // capabilitiesRoot yields an empty tree → conformant:true, capabilityCount:0:
    // the report is always well-formed.
    const tree = capabilitiesRoot(mirrorRoot);
    const { conformant, errors } = validate(tree);
    // After the hoist (Item A) validate()'s errors ARE the contract type — plain
    // pass-through, no .map, no cast.
    const conformanceErrors: ConformanceError[] = errors;
    // Count EVERY enumerated leaf (resolvable AND non-resolvable), so 0 honestly
    // means "no capability-shaped content found." A collision-only repo reads >0
    // (its leaves enumerate, even though none resolve) — never a false "empty".
    const walk = enumerateLeaves(tree);
    const capabilityCount = walk.leaves.length + walk.problems.length;

    return {
      source,
      sync,
      validation: { conformant, errors: conformanceErrors, capabilityCount },
    };
  });
}

// The degraded AddSourceResult for the (only-on-a-defect) path where a DEFECT is
// squashed out of onboardSource's `never` channel — the edge keeps its 201
// contract rather than throwing. The ONE author of this body (the server adapter
// and the route's residual guard both call it, so the wire shape is never
// hand-rolled at the route). Derives from the `Source` alone: a defect makes any
// disk read untrustworthy, so the freshness is `check_failed` (reason io), sha
// unknown. `conformant:false` is deliberate — a defect crashed validation, so its
// true conformance is UNKNOWN; reporting a clean empty repo would mislabel a crash.
export function degradedOnboardResult(source: Source): AddSourceResult {
  const sync: SourceSyncStatus = {
    sourceId: source.id,
    origin: source.origin,
    state: "check_failed",
    sha: null,
    fetchedAt: null,
    errorReason: "io",
  };
  return {
    source,
    sync,
    validation: {
      conformant: false,
      errors: [{ kind: "", name: "", message: "onboarding did not complete (defect)" }],
      capabilityCount: 0,
    },
  };
}
