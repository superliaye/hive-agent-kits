# ModelGateway Design

## What this ADR records

The interface, event stream, adapter mechanism, and error taxonomy for `src/model-gateway/` — the Hive-owned seam every LLM completion call passes through. Used by the `native` **Agent Backend** only; CLI-driven backends (`claude-code`, `codex`) bypass the Gateway entirely. Sanity-checked against Anthropic's Messages API streaming, OpenAI's Responses API streaming, Vercel AI SDK's `streamText` event taxonomy, and the live source of OpenClaw + Hermes Agent (locally cloned at `E:\dev\GitRepos\openclaw` and `E:\dev\GitRepos\hermes-agent`).

## Seam and scope

The Gateway is a deep module (one verb, narrow interface, large implementation surface hidden behind it):

```
complete(input: CompletionInput) → AsyncIterable<GatewayEvent>
```

Properties:

- **Single verb.** No `stream()` + `chat()` + `complete()` triad. Streaming is the default; non-streaming callers `for await` and accumulate.
- **Caller owns the tool-use loop.** Gateway emits tool-use events and stops at `done`. The native Run executor decides what to dispatch and what to send back as a tool result.
- **Stateless.** Caller passes the full message history every call. No conversation state inside the Gateway.
- **Pure transform.** Auth credentials are resolved by the **Secrets** module *before* `complete` is called; the Gateway is not a credential store. OAuth refresh, when needed, fires a caller-supplied callback (see `AuthInput`).
- **No internal retry.** Adapters surface errors via the event stream. Retry policy lives in the Run executor — every retry is a new `complete()` call, captured in the audit log.

## Canonical Message type

Hive's canonical Message is Anthropic-flavored content blocks. Industry is converging on this shape; pi-ai, Hermes, OpenAI's Responses API, and Gemini's `parts` all map cleanly to it.

```ts
type Message = {
  role: "user" | "assistant";        // no "system" role; system is top-level on CompletionInput
  content: ContentBlock[];
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string; providerMetadata?: Record<string, unknown> }
  | { type: "image"; source: { type: "base64" | "url"; media_type?: string; data: string } };
```

`system` is **not** a Message role — it's a top-level `system?: string` field on `CompletionInput`. Anthropic's API takes it that way and it matches the semantic (system instructions aren't a turn in the conversation).

## `CompletionInput`

```ts
type CompletionInput = {
  model: string;                                    // "anthropic/claude-opus-4-7"
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  thinking?: {
    effort?: "off" | "low" | "medium" | "high";     // semantic; adapter maps
    budgetTokens?: number;                          // precise override (esp. Anthropic)
  };
  limits?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  auth: AuthInput;
  providerHints?: { [provider: string]: unknown };  // opaque at interface; typed inside each adapter
  signal?: AbortSignal;
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;                          // Draft 7; adapter handles dialect
};

type AuthInput =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "oauth";
      credentials: { access: string; refresh: string; expires: number };
      onRefresh: (newCreds: { access: string; refresh: string; expires: number }) => Promise<void>;
    };
```

Sub-decisions worth pinning:

- **Model identifier** is a `provider/model` string. pi-ai uses this; readable in Harness configs and logs; parsed once at adapter dispatch.
- **Tools** are JSON Schema Draft 7 at the canonical wire. Built-in TS Tools convert their Zod schemas to JSON Schema before registration. MCP-sourced tools already arrive as JSON Schema. Adapter handles per-provider dialect quirks (OpenAI strict mode, Gemini's keyword subset).
- **Thinking control** is semantic with a precise override. Most users think in `"low" | "medium" | "high"`; `budgetTokens` is an escape hatch for users who want exact Anthropic budget control.
- **Provider hints** are `Record<string, unknown>` at the interface; each adapter Zod-validates its slice (`hints.anthropic`, `hints.openai`). Wrong-shape hints fail at adapter boundary with `invalid_request`.
- **OAuth refresh is Gateway-internal via callback.** Anthropic OAuth tokens last 1 hour; long Runs can outlast that. Adapter detects mid-stream expiry, refreshes via pi-ai's `getOAuthApiKey`, fires `onRefresh` so the Secrets module persists. Caller-managed refresh can't handle mid-stream expiry without aborting and restarting (losing partial output).
- **Cancellation is `AbortSignal` only.** Standard Web API; on abort the in-flight HTTP request is canceled and the iterable ends after emitting `{type: "done", finishReason: "cancelled"}`.

## `GatewayEvent` v1 stream

Tagged union with a `type` discriminator. Adding new event types later is additive; removing/renaming is breaking. 15 event types in v1:

```ts
type GatewayEvent =
  // Text blocks
  | { type: "text_start"; blockIndex: number }
  | { type: "text_delta"; blockIndex: number; delta: string }
  | { type: "text_end"; blockIndex: number }
  // Thinking / reasoning blocks
  | { type: "thinking_start"; blockIndex: number }
  | { type: "thinking_delta"; blockIndex: number; delta: string }
  | { type: "thinking_end"; blockIndex: number; providerMetadata?: Record<string, unknown> }
  // Refusal stream (OpenAI emits as distinct channel; Anthropic falls back to text_delta + finishReason)
  | { type: "refusal_delta"; delta: string }
  // Client-executed tools (caller dispatches; round-trips through next call)
  | { type: "tool_use_start"; blockIndex: number; id: string; name: string }
  | { type: "tool_use_delta"; blockIndex: number; id: string; delta: string }   // partial JSON
  | { type: "tool_use_end"; blockIndex: number; id: string; args: unknown }     // parsed args
  // Server-executed tools (opaque to caller; provider runs them, lifecycle not args/result)
  | { type: "server_tool"; blockIndex: number; id: string; name: string;
      phase: "start" | "progress" | "result"; payload?: unknown }
  // Termination
  | { type: "usage"; inputTokens: number; outputTokens: number;
      reasoningTokens?: number;
      cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "done"; finishReason:
      | "stop" | "tool_use" | "length" | "content_policy"
      | "refusal" | "pause" | "error" | "cancelled" }
  | { type: "error"; code: GatewayErrorCode; message: string; retryable: boolean };
```

Specific shape opinions:

- **`blockIndex` on every block-scoped event.** Anthropic emits content blocks in parallel (interleaved text + thinking + tool_use); pi-ai's `contentIndex` and Vercel's stable IDs solve the same problem. Without it, parallel tool-use args interleave ambiguously between unrelated text/thinking.
- **`tool_use_end` carries parsed `args: unknown`.** pi-ai's `toolcall_end` ships the assembled `{id, name, arguments}`; Vercel's `tool-call` event has parsed `input`. Forcing every consumer to reassemble fragments from `tool_use_delta` is unnecessary friction.
- **`thinking_end.providerMetadata`** instead of a specific `signature?` field. Anthropic's signature, OpenAI's `encrypted_content`, Gemini's `thoughtSignature` all live here. Vercel had real production bugs from losing these on error paths — treat as load-bearing; propagate through error events too.
- **`refusal_delta` is its own event.** OpenAI's `response.refusal.delta` is a distinct channel. Anthropic emits refusals as `text_delta` and only signals via `done.finishReason: "refusal"` — both paths supported faithfully.
- **`server_tool` family** for Anthropic's `server_tool_use` (web_search, code_execution, mcp_tool) and OpenAI's `file_search_call / web_search_call / code_interpreter_call / image_generation_call / mcp_call.*`. Different lifecycle from client tools (provider runs them; no args round-trip). Even if Hive v1 doesn't enable them, the union must accommodate them — additive later forces consumer code changes.
- **`pause` finishReason** for Anthropic's `pause_turn` (long-running server tools — model says "call me back").
- **Usage is emitted exactly once**, right before `done`. Per-chunk `usage_partial` is a v1.1 addition. Reasoning tokens are their own bucket (`reasoningTokens?`); some providers bill them differently from completion tokens.
- **`cacheReadTokens` / `cacheWriteTokens`** explicit token counts. pi-ai's `cacheRead`/`cacheWrite` reads ambiguously (event count? token count?). Be explicit.

## Error taxonomy

```ts
type GatewayErrorCode =
  | "auth_failed"           // 401 — invalid/expired credentials       (not retryable)
  | "quota_exceeded"        // billing/usage caps hit                  (not retryable)
  | "rate_limited"          // 429                                     (retryable)
  | "model_overloaded"      // Anthropic 529 / overloaded_error        (retryable)
  | "context_too_long"      // input exceeds model's window            (not retryable)
  | "invalid_request"       // schema/shape violation                  (not retryable)
  | "model_not_found"       // unknown / deprecated model              (not retryable)
  | "content_policy"        // safety filter blocked input             (not retryable)
  | "network"               // timeout / connection reset / DNS        (retryable)
  | "server"                // provider 5xx                            (retryable)
  | "unknown";              // catch-all                               (default not retryable)
```

The `retryable` flag on the `error` event is advisory. The Run executor decides actual retry policy with backoff — every retry is a fresh `complete()` call, recorded in the audit log. Hermes' `agent/error_classifier.py` is a working reference.

## Adapters

Function-based registration. The Gateway exposes a tiny registration verb; adapters self-register on import.

```ts
type GatewayAdapter = {
  providers: string[];                                          // ["anthropic", "openai", ...]
  complete(input: CompletionInput): AsyncIterable<GatewayEvent>;
};

export function registerAdapter(adapter: GatewayAdapter): void;
export function resolve(model: string): GatewayAdapter;         // parses "provider/model"
```

Two adapters from day 1:

- **`pi-ai`** — covers most providers via `@earendil-works/pi-ai`. Default for `anthropic/*`, `openai/*`, `gemini/*`, `bedrock/*`, `mistral/*`, `openrouter/*`, etc.
- **`fake`** — emits scripted `GatewayEvent` streams from a fixture. Required infrastructure: makes the seam real (two adapters = real seam, not hypothetical) and makes the Run executor testable without network calls.

Future adapters (direct Anthropic SDK, direct OpenAI SDK, local Ollama, vLLM, etc.) plug in at the same registration verb.

## Capability layer leakage

Per the agnostic analysis in ADR-0002, leaks live at the Run-start adapter, not at the Capability manifest:

- **Skills** travel cleanly — per-provider concern is cache breakpoint placement (handled in `providerHints.anthropic.cacheControl`).
- **Tools** need per-provider schema dialect — JSON Schema is canonical; adapter down-converts.
- **MCP Servers** are protocol-neutral; their Tool exposure inherits Tool-level leaks.
- **Agent Harness** is structurally clean; thinking-effort + cache-control surface via typed `providerHints` and the typed `thinking` field.

## File layout

```
src/model-gateway/
├── index.ts              # Public API: complete(), registerAdapter(), resolve()
├── types.ts              # CompletionInput, GatewayEvent, ToolDef, Message, AuthInput, GatewayErrorCode
├── registry.ts           # Adapter registration + resolve()
├── errors.ts             # GatewayError class, retryable classification helpers
├── adapters/
│   ├── pi-ai.ts          # pi-ai adapter (default for most providers)
│   ├── fake.ts           # fake adapter for tests
│   └── README.md         # How to write an adapter
└── README.md             # Module overview and contract
```

## What this defers

- **Citations / annotations** — Anthropic's `citations_delta`, OpenAI's `output_text.annotation.added`, Vercel's `source`. Real RAG feature; Hive has no grounded-response surface in v1. Additive later.
- **File / multimodal output chunks** — Vercel's `file`, OpenAI's `image_generation` streaming. Hive renders text + images-in, no streamed images-out in v1.
- **Audio / PDF input** in `ContentBlock`. Anthropic and Gemini support these; no v1 caller needs them.
- **Per-chunk `usage_partial`** — some providers stream usage incrementally. v1 emits a final `usage` only.
- **Resumable streams** — Vercel's open pain point. Add when v1 hits a real network reliability issue.
- **`responseFormat`** for structured output (JSON schema enforcement). Add when first caller needs it.
- **`streamId` / `metadata`** input fields. Speculative; add when used.

## What this rejects (and why)

- **Vercel-style `abort` as a separate event.** Our `done.finishReason: "cancelled"` keeps termination unified; one terminal path is simpler for consumers.
- **Vercel-style `step_start` / `step_end`.** At the Gateway, each `complete()` is exactly one step; step iteration belongs to the Run module above. Adding step events at this layer conflates concerns.
- **Cumulative usage across `message_delta` events** (Anthropic's quirk). v1 emits one final `usage` event before `done`.
- **Internal retry inside the Gateway.** Caller (Run executor) owns retry policy; audit log captures each attempt.
- **Skill-style manifest-only shell Tools as a Gateway concern.** Gateway only knows about `ToolDef` with a JSON Schema. Where the schema came from (built-in TS, MCP, future kinds) is opaque to the Gateway.

## References (sanity-checked against)

- Anthropic Messages API streaming docs — full content-block taxonomy, stop reasons, signature flow.
- OpenAI Responses API streaming docs — event types, reasoning summary vs raw, server-side tools, encrypted reasoning state.
- Vercel AI SDK `streamText` (`TextStreamPart` union) — `packages/ai/src/generate-text/stream-text-result.ts`. Production-deployed unified abstraction.
- OpenClaw `src/agents/anthropic-transport-stream.ts` (canonical event emission) and `src/agents/btw.ts` (canonical consumer pattern) at `E:\dev\GitRepos\openclaw`.
- Hermes Agent `agent/transports/types.py` (`NormalizedResponse`) and provider adapters at `E:\dev\GitRepos\hermes-agent`. Note: Hermes does not stream at the canonical layer — non-stream-per-turn is a deliberate choice.

## Verification

This ADR is correct if, after implementation:

1. A `complete()` call against the `fake` adapter with a scripted stream produces the expected `GatewayEvent` sequence — testable without network.
2. A `complete()` call against the `pi-ai` adapter with an Anthropic model produces real streaming events (`text_delta` + `thinking_delta` + `tool_use_*` + `usage` + `done`) for a prompt that exercises tools and extended thinking.
3. The same call canceled via `AbortSignal` ends with `{type: "done", finishReason: "cancelled"}` and no further events.
4. An OAuth-authenticated call whose access token expires mid-stream fires `onRefresh` and continues without aborting the iterable.
5. A call with malformed `providerHints.anthropic` fails with `{type: "error", code: "invalid_request", retryable: false}` *before* any HTTP request is made.
6. Adding a third adapter (e.g., direct-Anthropic SDK to hedge pi-ai churn) requires no changes outside `src/model-gateway/adapters/` and `src/model-gateway/registry.ts`.

If any of these is false, the design is wrong — fix here before further commitments.
