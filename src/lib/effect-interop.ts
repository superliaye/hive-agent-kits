// Coexistence boundary for the Effect migration (docs/effect-migration-plan.md).
// Bridges an Effect Stream back to the plain-async AsyncIterable contract that
// unmigrated consumers and the existing test suite still depend on. Deleted
// when the last plain-async consumer is gone.

import { Stream } from "effect";

/**
 * Drain a fully-provided Effect Stream into an AsyncIterable, mapping a typed
 * failure in `E` into one or more terminal in-band elements instead of a thrown
 * error. `onError` returns the terminal sequence (e.g. a backend adapter maps a
 * failure to an `error` event followed by a `done` event), so a migrated
 * module's Stream keeps the legacy stream's contract.
 */
export function streamToAsyncIterable<A, E>(
  stream: Stream.Stream<A, E>,
  onError: (error: E) => readonly A[],
): AsyncIterable<A> {
  return Stream.toAsyncIterable(stream.pipe(Stream.catch((e) => Stream.fromIterable(onError(e)))));
}
