// Coexistence boundary for the Effect migration (docs/effect-migration-plan.md).
// Bridges an Effect Stream back to the plain-async AsyncIterable contract that
// unmigrated consumers and the existing test suite still depend on. Deleted
// when the last plain-async consumer is gone.

import { Stream } from "effect";

/**
 * Drain a fully-provided Effect Stream into an AsyncIterable, mapping a typed
 * failure in `E` into a terminal element instead of a thrown error. `onError`
 * turns the failure into an in-band terminal value (e.g. the gateway's `error`
 * event), so a migrated module's Stream keeps the legacy stream's contract.
 */
export function streamToAsyncIterable<A, E>(
  stream: Stream.Stream<A, E>,
  onError: (error: E) => A,
): AsyncIterable<A> {
  return Stream.toAsyncIterable(stream.pipe(Stream.catch((e) => Stream.make(onError(e)))));
}
