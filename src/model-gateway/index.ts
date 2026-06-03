// Public API for the ModelGateway module.
//
// See docs/adr/0005-model-gateway-design.md.

import type { Stream } from "effect";
import { streamToAsyncIterable } from "../lib/effect-interop.ts";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import { completeStream } from "./effect/complete.ts";
import type { GatewayFailure } from "./effect/failure.ts";
import { toErrorEvent } from "./effect/failure.ts";
import { GatewayError, isRetryable } from "./errors.ts";
import { createGatewayRegistry } from "./registry.ts";
import type {
  CompletionInput,
  GatewayAdapter,
  GatewayEvent,
  GatewayModuleEvents,
} from "./types.ts";

export type ModelGateway = {
  // Stream a completion. Resolves the adapter by `input.model`'s provider
  // prefix, then forwards. Per-completion events (deltas, tool calls, etc.)
  // arrive on this stream — not on `events`. Legacy AsyncIterable contract:
  // a typed failure surfaces as a terminal in-band `error` event.
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;

  // Effect-native completion: the typed gateway Stream. A resolve miss or a
  // thrown adapter is a `GatewayFailure` in the Stream's `E` channel. This is
  // the migrated consumer-facing surface (the Run executor's completion port).
  completeStream(input: CompletionInput): Stream.Stream<GatewayEvent, GatewayFailure>;

  // Register an adapter. Returns a disposer that unregisters the adapter
  // and emits `adapter.unregistered`.
  registerAdapter(adapter: GatewayAdapter): () => void;

  // Module-level events: adapter registration changes. The audit subscriber
  // attaches here for deployment-level visibility of which adapters are live.
  events: TypedEmitter<GatewayModuleEvents>;
};

export function createGateway(): ModelGateway {
  const registry = createGatewayRegistry();
  return {
    // Effect-native internally (typed `E`); bridged back to the AsyncIterable
    // contract here. A typed `GatewayFailure` (resolve failure or a thrown
    // adapter) surfaces as a terminal `error` event followed by `done(error)`,
    // honoring the GatewayEvent contract (ADR-0005: an `error` is always
    // followed by `done`) for consumers not yet migrated.
    complete: (input) =>
      streamToAsyncIterable(completeStream(registry, input), (failure) => [
        toErrorEvent(failure),
        { type: "done", finishReason: "error" },
      ]),
    completeStream: (input) => completeStream(registry, input),
    registerAdapter: registry.registerAdapter,
    events: registry.events,
  };
}

export { GatewayError, isRetryable };

export type {
  AuthInput,
  CompletionInput,
  ContentBlock,
  FinishReason,
  GatewayAdapter,
  GatewayErrorCode,
  GatewayEvent,
  GatewayModuleEvents,
  JsonSchema,
  Message,
  ThinkingEffort,
  ToolDef,
} from "./types.ts";
