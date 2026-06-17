// BackendRun port — the seam each vendor-SDK adapter satisfies (D2). One verb:
// `run(invocation) → Stream<RunEvent, BackendError>`, an Effect Stream at the
// I/O edge (AGENTS.md: the SDK call is wrapped with Stream.fromAsyncIterable and
// failures map into the typed `BackendError` channel). The executor consumes the
// chosen adapter's Stream and forwards each RunEvent through the unchanged
// `startRun → AsyncIterable<RunEvent>` seam.
//
// Lifecycle RunEvents (`run.completed`/`run.failed`/`run.cancelled`) are emitted
// BY the adapter as the stream's terminal element; `run.started` is emitted by
// the executor before dispatch (the Run row exists before the first adapter
// event). The adapter owns everything between: text/tool deltas wrapped in
// `model.event`, plus the audit emissions relocated here (P6).

import type { Stream } from "effect";
import type { RunEvent } from "../types.ts";
import type { BackendError } from "./errors.ts";
import type { BackendInvocation } from "./invocation.ts";

export type BackendRun = {
  run(invocation: BackendInvocation): Stream.Stream<RunEvent, BackendError>;
};
