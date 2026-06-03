// Effect-native completion: resolve the adapter in the typed `E` channel, then
// wrap its AsyncIterable at the I/O edge with `Stream.fromAsyncIterable`. A
// thrown adapter error becomes a `GatewayFailure` in `E` rather than an
// out-of-band throw. This is the gateway's instance of "plain async only at
// I/O edges" (ADR-0010, ADR-0011).

import { Effect, Stream } from "effect";
import { log } from "../../lib/log.ts";
import { GatewayError } from "../errors.ts";
import type { GatewayRegistry } from "../registry.ts";
import type { CompletionInput, GatewayEvent } from "../types.ts";
import { GatewayFailure } from "./failure.ts";

// `toFailure` is the `onError` of `Stream.fromAsyncIterable`, so it runs only
// when an adapter THROWS instead of emitting an in-band `error` event — an
// adapter-contract anomaly. Trace it here (the throw site has the precise
// signal); the run-level consequence is already an audit-visible `run.failed`.
function toFailure(cause: unknown): GatewayFailure {
  log().warn({ module: "model-gateway", err: cause }, "adapter threw out of band");
  if (cause instanceof GatewayFailure) return cause;
  if (cause instanceof GatewayError) {
    return new GatewayFailure({ code: cause.code, message: cause.message });
  }
  return new GatewayFailure({
    code: "unknown",
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export function completeStream(
  registry: GatewayRegistry,
  input: CompletionInput,
): Stream.Stream<GatewayEvent, GatewayFailure> {
  return Stream.unwrap(
    Effect.map(registry.resolveEffect(input.model), (adapter) =>
      Stream.fromAsyncIterable(adapter.complete(input), toFailure),
    ),
  );
}
