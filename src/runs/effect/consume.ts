// Drain the gateway's typed completion Stream for the (still plain-async)
// executor. A typed GatewayFailure in the Stream's `E` channel is caught
// inside the Stream and surfaced as a terminal sentinel element — so the
// executor consumes a single AsyncIterable with NO out-of-band try/catch.
// This is where Phase 1's typed `E` pays off: the failure arrives as data
// carrying its real GatewayErrorCode, not an untyped throw collapsed to
// "unknown".

import { Stream } from "effect";
import type { GatewayFailure } from "../../model-gateway/effect/failure.ts";
import type { GatewayEvent } from "../../model-gateway/types.ts";

export type CompletionItem =
  | { kind: "event"; event: GatewayEvent }
  | { kind: "failure"; failure: GatewayFailure };

export function drainCompletion(
  stream: Stream.Stream<GatewayEvent, GatewayFailure>,
): AsyncIterable<CompletionItem> {
  const tagged: Stream.Stream<CompletionItem, never> = stream.pipe(
    Stream.map((event): CompletionItem => ({ kind: "event", event })),
    Stream.catch((failure) =>
      Stream.succeed<CompletionItem>({ kind: "failure", failure }),
    ),
  );
  return Stream.toAsyncIterable(tagged);
}
