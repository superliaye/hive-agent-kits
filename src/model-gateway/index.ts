// Public API for the ModelGateway module.
//
// See docs/adr/0005-model-gateway-design.md.

import type { TypedEmitter } from "../lib/typed-emitter.ts";
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
  // arrive on this stream — not on `events`.
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;

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
    complete: (input) => registry.resolve(input.model).complete(input),
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
