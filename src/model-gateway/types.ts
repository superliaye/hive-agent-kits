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
      onRefresh: (newCreds: {
        access: string;
        refresh: string;
        expires: number;
      }) => Promise<void>;
    };

export type ThinkingEffort = "off" | "low" | "medium" | "high";

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

export type GatewayAdapter = {
  providers: string[];
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;
};
