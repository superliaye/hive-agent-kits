// ModelGateway types per docs/adr/0005-model-gateway-design.md

export type JsonSchema = Record<string, unknown>;

// Canonical Message shape: Anthropic-flavored content blocks. System is top-level on CompletionInput.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "image";
      source: { type: "base64" | "url"; media_type?: string; data: string };
    };

export type Message = {
  role: "user" | "assistant";
  content: ContentBlock[];
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type AuthInput =
  | { kind: "apiKey"; apiKey: string }
  | {
      kind: "oauth";
      credentials: { access: string; refresh: string; expires: number };
      /**
       * Token-refresh contract — load-bearing for every adapter that
       * handles `kind: "oauth"`.
       *
       * When the adapter refreshes the access token (typically because
       * it was expired before the call), it MUST `await onRefresh(newCreds)`
       * before using the new apiKey. The caller (Secrets module) is
       * responsible for persisting `newCreds` so the next Run starts with
       * an unexpired token. Adapters that skip this call will appear to
       * work in-memory but force re-login on every daemon restart.
       *
       * If `onRefresh` throws, the adapter should surface
       * `{type: "error", code: "auth_failed"}` — persistence failure
       * downstream of a successful refresh leaves the on-disk state
       * inconsistent with what the model just accepted.
       */
      onRefresh: (newCreds: { access: string; refresh: string; expires: number }) => Promise<void>;
    };

// Mirrors pi-ai's `ModelThinkingLevel` ("off" | ThinkingLevel). The non-"off"
// members are exactly pi-ai's `ThinkingLevel`, so the adapter maps effort →
// reasoning without a cast. A model only supports a SUBSET of these (the keys
// of its `thinkingLevelMap`); the catalog surfaces the per-model set.
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CompletionInput = {
  model: string;
  messages: Message[];
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
  auth: AuthInput;
  providerHints?: { [provider: string]: unknown };
  signal?: AbortSignal;
};

// Event stream — 15 variants

export type FinishReason =
  | "stop"
  | "tool_use"
  | "length"
  | "content_policy"
  | "refusal"
  | "pause"
  | "error"
  | "cancelled";

export type GatewayErrorCode =
  | "auth_failed"
  | "quota_exceeded"
  | "rate_limited"
  | "model_overloaded"
  | "context_too_long"
  | "invalid_request"
  | "model_not_found"
  | "content_policy"
  | "network"
  | "server"
  | "unknown";

export type GatewayEvent =
  // Text blocks
  | { type: "text_start"; blockIndex: number }
  | { type: "text_delta"; blockIndex: number; delta: string }
  | { type: "text_end"; blockIndex: number }
  // Thinking / reasoning blocks
  | { type: "thinking_start"; blockIndex: number }
  | { type: "thinking_delta"; blockIndex: number; delta: string }
  | {
      type: "thinking_end";
      blockIndex: number;
      providerMetadata?: Record<string, unknown>;
    }
  // Refusal stream
  | { type: "refusal_delta"; delta: string }
  // Client-executed tools
  | { type: "tool_use_start"; blockIndex: number; id: string; name: string }
  | { type: "tool_use_delta"; blockIndex: number; id: string; delta: string }
  | { type: "tool_use_end"; blockIndex: number; id: string; args: unknown }
  // Server-executed tools
  | {
      type: "server_tool";
      blockIndex: number;
      id: string;
      name: string;
      phase: "start" | "progress" | "result";
      payload?: unknown;
    }
  // Termination
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: "done"; finishReason: FinishReason }
  | {
      type: "error";
      code: GatewayErrorCode;
      message: string;
      retryable: boolean;
    };

/**
 * An adapter at the ModelGateway Seam. One verb (`complete`); contract
 * covered by the GatewayEvent stream + the obligations below.
 *
 * Adapters that accept `auth.kind === "oauth"` MUST honor the token-refresh
 * contract documented on `AuthInput.onRefresh`: when the adapter refreshes
 * an access token mid-call, it must `await onRefresh(newCreds)` so the
 * Secrets module can persist them. Adapters that only handle `apiKey`
 * (e.g. `fake` for tests, the `claude-cli` adapter) are exempt.
 *
 * See ADR-0005 (§AuthInput, §Adapters) and ADR-0008 (§OAuth refresh).
 */
export type GatewayAdapter = {
  providers: string[];
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;
  /**
   * Enumerate the models this adapter can route for `provider` (one of its
   * `providers`). Optional — adapters that can't enumerate (e.g. test fakes)
   * omit it and contribute no catalog entries.
   */
  listModels?(provider: string): Array<{ id: string; label?: string }>;
};

// A model the gateway can route, surfaced by the models-catalog endpoint.
// `model` is the "provider/modelId" string the executor and Run route consume.
export type AvailableModel = {
  provider: string;
  modelId: string;
  model: string;
  label?: string;
};

// Module-level event stream for adapter registration changes.
// Per-completion events (text deltas, tool calls, etc.) flow through
// `complete()`'s AsyncIterable<GatewayEvent>, not through here — those
// are causally owned by the Run that triggered them.
export type GatewayModuleEvents = {
  "adapter.registered": { providers: readonly string[] };
  "adapter.unregistered": { providers: readonly string[] };
};
