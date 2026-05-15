// Public API for the ModelGateway module.
//
// See docs/adr/0005-model-gateway-design.md.

export { registerAdapter, resolve } from "./registry.ts";
export { GatewayError, isRetryable } from "./errors.ts";

import { resolve } from "./registry.ts";
import type { CompletionInput, GatewayEvent } from "./types.ts";

export function complete(input: CompletionInput): AsyncIterable<GatewayEvent> {
  const adapter = resolve(input.model);
  return adapter.complete(input);
}

export type {
  AuthInput,
  CompletionInput,
  ContentBlock,
  FinishReason,
  GatewayAdapter,
  GatewayErrorCode,
  GatewayEvent,
  JsonSchema,
  Message,
  ThinkingEffort,
  ToolDef,
} from "./types.ts";
