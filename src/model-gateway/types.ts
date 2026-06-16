// ModelGateway types (ADR-0005) — TRANSITION SHIM.
//
// The cross-cutting message/effort/auth primitives have relocated to `src/lib/`
// and the stream-event vocabulary to `src/runs/backends/stream-events.ts`
// (Migration §1, Q-types). This file re-exports them under their legacy names so
// the gateway's own internals keep compiling until the whole `model-gateway/`
// dir is deleted (P5.3). No consumer outside `model-gateway/` should import from
// here — KEPT modules already point at `lib/`.

import type { ThinkingEffort } from "../lib/effort.ts";
import type {
  BackendErrorCode,
  FinishReason as BackendFinishReason,
  BackendStreamEvent,
} from "../runs/backends/stream-events.ts";

export type { AuthInput } from "../lib/auth.ts";
export type { ThinkingEffort } from "../lib/effort.ts";
export { EFFORT_ORDER } from "../lib/effort.ts";
export type { ContentBlock, JsonSchema, Message } from "../lib/messages.ts";

export type FinishReason = BackendFinishReason;
export type GatewayErrorCode = BackendErrorCode;
export type GatewayEvent = BackendStreamEvent;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: import("../lib/messages.ts").JsonSchema;
};

export type CompletionInput = {
  model: string;
  messages: import("../lib/messages.ts").Message[];
  system?: string;
  tools?: ToolDef[];
  thinking?: {
    effort?: ThinkingEffort;
    budgetTokens?: number;
  };
  limits?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  auth: import("../lib/auth.ts").AuthInput;
  providerHints?: { [provider: string]: unknown };
  signal?: AbortSignal;
};

export type GatewayAdapter = {
  providers: string[];
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;
  listModels?(provider: string): Array<{ id: string; label?: string; efforts: ThinkingEffort[] }>;
};

export type AvailableModel = {
  provider: string;
  modelId: string;
  model: string;
  label?: string;
  efforts: ThinkingEffort[];
};

export type GatewayModuleEvents = {
  "adapter.registered": { providers: readonly string[] };
  "adapter.unregistered": { providers: readonly string[] };
};
