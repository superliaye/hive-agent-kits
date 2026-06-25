// Typed error channel for the Kit module (AGENTS.md: errors are values in `E`).
//
// Two taxonomies, each a discriminated union over a `reason` so callers map them
// into HTTP/wire codes without stringly-typed handling. (Ledger read failures
// are returned as null by design — a malformed ledger is "no prior install" —
// so there is no LedgerError: that would be an honest-taxonomy lie.)

import { Data } from "effect";

// Sync failures. `offline` and `rate_limited` are distinct so the UI never
// reports "up to date" on a network failure. `rate_limited` surfaces the GitHub
// X-RateLimit-Reset epoch when present. `missing_starter_root` is the local-sync
// equivalent of a bad config — the bundled Starter content root is absent (a bad
// HIVE_STARTER_ROOT override or a packaging miss); isolated to that Source.
// `timeout` is the add-time bounded-sync abort (#33): a sync that outruns the
// request budget folds into the Source's freshness as `check_failed`, so the add
// can never hang the HTTP request.
export type SyncFailureReason =
  | "offline"
  | "rate_limited"
  | "parse"
  | "io"
  | "missing_starter_root"
  | "timeout";

export class SyncError extends Data.TaggedError("SyncError")<{
  readonly reason: SyncFailureReason;
  readonly message: string;
  // Epoch seconds from X-RateLimit-Reset, only on `rate_limited`.
  readonly rateLimitReset?: number;
}> {}

// Deploy failures. `missing_binary` is the pre-flight abort (names the tool);
// `collision` is an un-deployable colliding leaf name; `not_redirected` is the
// A0 guard refusing a real installer with no redirected child env; `io` is a
// filesystem fault during apply (per-kind failures stay in the per-kind result,
// not the typed channel).
export type DeployFailureReason = "missing_binary" | "collision" | "not_redirected" | "io";

export class DeployError extends Data.TaggedError("DeployError")<{
  readonly reason: DeployFailureReason;
  readonly message: string;
  // For `missing_binary`: the tool that was absent (claude | git | npx).
  readonly tool?: string;
  // For `collision`: the colliding capability name.
  readonly name?: string;
}> {}
