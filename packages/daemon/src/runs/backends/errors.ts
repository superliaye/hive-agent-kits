// BackendError taxonomy — the typed `E` channel for a backend adapter's
// `run(invocation) → Stream<RunEvent, BackendError>` (D2). An adapter never
// throws an untyped error: a spawn failure, an auth miss, or a classified SDK
// failure is a value here. The dispatch consumer maps a terminal `BackendError`
// onto `Run["errorCode"]` (types.ts) and a `run.failed` RunEvent.

import { Data } from "effect";
import type { BackendErrorCode } from "./stream-events.ts";

// Run-owned backend failure codes that are NOT part of the stream vocabulary —
// the SDK process couldn't be spawned, or it exited nonzero before/without a
// classified stream error. Folded into `Run["errorCode"]` alongside
// BackendErrorCode (types.ts already admits both).
export type BackendProcessCode = "backend_unavailable" | "backend_exited";

// The adapter's typed error value. `code` is either a stream-classified
// BackendErrorCode (auth_failed, context_too_long, …) or a process-level
// BackendProcessCode (couldn't spawn / exited nonzero).
export class BackendError extends Data.TaggedError("BackendError")<{
  readonly code: BackendErrorCode | BackendProcessCode;
  readonly message: string;
}> {}
