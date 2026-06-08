// pi-ai adapter — wraps `@earendil-works/pi-ai`'s `streamSimple()` and
// translates its event stream into Hive's `GatewayEvent` union.
//
// Per ADR-0002, pi-ai is Hive's default multi-provider transport (anthropic,
// openai, google, mistral, bedrock, openrouter, …). Per ADR-0005 this adapter
// is the only file in the daemon that imports pi-ai directly.
//
// Auth: per-call `apiKey` (ADR-0005 §AuthInput, locked per Decision Sheet #6).
//       `kind: "oauth"` surfaces `auth_failed` — OAuth is the primary auth
//       path for Hive but requires the Secrets module (Part 2) to persist
//       `{access, refresh, expires}` credentials and drive refresh. Wired
//       once Secrets lands; the swap point is this `kind` branch + a call
//       to pi-ai's `getOAuthApiKey()` (re-exported via the `/oauth` subpath).
//
// Tools: included (Decision Sheet #3). Hive's `ToolDef.inputSchema` is JSON
//        Schema Draft 7; pi-ai expects `TSchema` (TypeBox). Wrapped with
//        `Type.Unsafe(jsonSchema)` — typebox's documented entry point for raw
//        JSON Schema, no structural-cast escape hatches.
//
// Thinking: included (Decision Sheet #4). Hive's `effort` maps to pi-ai's
//           `reasoning: ThinkingLevel`. `budgetTokens` → `thinkingBudgets[level]`.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  KnownProvider,
  Model,
  Message as PiMessage,
  StopReason as PiStopReason,
  TextContent,
  ThinkingBudgets,
  ThinkingContent,
  ThinkingLevel,
  ThinkingLevelMap,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { getModels, streamSimple, Type } from "@earendil-works/pi-ai";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import type {
  CompletionInput,
  ContentBlock,
  FinishReason,
  GatewayAdapter,
  GatewayErrorCode,
  GatewayEvent,
  Message,
  ThinkingEffort,
  ToolDef,
} from "../types.ts";
import { EFFORT_ORDER } from "../types.ts";

// Which Hive `provider/model` prefixes this adapter handles. Expanded as
// pi-ai gains stable provider support; each entry must be a `KnownProvider`
// in pi-ai's registry (see node_modules/@earendil-works/pi-ai/dist/types.d.ts).
//
// `openai-codex` (ChatGPT Plus/Pro) is OAuth-only: its models carry the
// `openai-codex-responses` api internally (pi-ai picks it from the resolved
// Model), and the OAuth access token is used as the apiKey — both handled by
// the generic OAuth path below, so allowlisting is all that's needed.
const PI_AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "mistral",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "deepseek",
  "github-copilot",
  "vercel-ai-gateway",
  "fireworks",
  "together",
] as const;

type PiProvider = (typeof PI_AI_PROVIDERS)[number];

function isPiProvider(p: string): p is PiProvider {
  return (PI_AI_PROVIDERS as readonly string[]).includes(p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Message translation: Hive → pi-ai
// ─────────────────────────────────────────────────────────────────────────────

// Hive carries `tool_result` as a ContentBlock inside a `user` Message
// (Anthropic-flavored). pi-ai treats `toolResult` as a top-level role
// (`ToolResultMessage`). Splitting requires the tool *name* for each
// tool_use_id, which Hive's `tool_result` block doesn't carry — we recover
// it by scanning earlier assistant messages for the matching `tool_use`.
function buildToolNameIndex(messages: Message[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        index.set(block.id, block.name);
      }
    }
  }
  return index;
}

function flattenToolResultContent(
  content: string | ContentBlock[],
): (TextContent | ImageContent)[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const out: (TextContent | ImageContent)[] = [];
  for (const block of content) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      block.source.type === "base64" &&
      block.source.media_type
    ) {
      out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
    }
    // tool_use / tool_result / thinking inside a tool_result.content are
    // not part of the Anthropic schema in practice; drop.
  }
  return out;
}

function translateUserMessages(
  msg: Message,
  toolNames: Map<string, string>,
  now: number,
): PiMessage[] {
  const text: (TextContent | ImageContent)[] = [];
  const toolResults: ToolResultMessage[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      text.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      block.source.type === "base64" &&
      block.source.media_type
    ) {
      text.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
    } else if (block.type === "tool_result") {
      const toolName = toolNames.get(block.tool_use_id);
      if (!toolName) {
        // Tool result without a matching prior tool_use is a caller bug.
        // Surface as a text block so the model still has the content;
        // pi-ai would otherwise reject the message.
        text.push({
          type: "text",
          text: `[tool_result for unknown tool_use_id=${block.tool_use_id}]`,
        });
        continue;
      }
      toolResults.push({
        role: "toolResult",
        toolCallId: block.tool_use_id,
        toolName,
        content: flattenToolResultContent(block.content),
        isError: block.is_error ?? false,
        timestamp: now,
      });
    }
  }
  const out: PiMessage[] = [];
  if (text.length > 0) {
    const userMsg: UserMessage = { role: "user", content: text, timestamp: now };
    out.push(userMsg);
  }
  out.push(...toolResults);
  return out;
}

function translateAssistantMessage(msg: Message, now: number): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      const thinking: ThinkingContent = {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature && { thinkingSignature: block.signature }),
      };
      content.push(thinking);
    } else if (block.type === "tool_use") {
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: (block.input as Record<string, unknown>) ?? {},
      });
    }
    // tool_result inside an assistant message is invalid per Anthropic schema; drop.
    // image: Hive currently has no path for images in assistant content; drop.
  }
  // Replayed assistants need plausible usage/api/provider/model; the values
  // are not sent over the wire for prior turns — pi-ai uses them for
  // diagnostics only.
  return {
    role: "assistant",
    content,
    api: "",
    provider: "",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: now,
  };
}

export function translateMessages(messages: Message[]): PiMessage[] {
  const toolNames = buildToolNameIndex(messages);
  const now = Date.now();
  const out: PiMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push(...translateUserMessages(msg, toolNames, now));
    } else {
      out.push(translateAssistantMessage(msg, now));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool / thinking translation
// ─────────────────────────────────────────────────────────────────────────────

function translateTools(tools: ToolDef[] | undefined): Context["tools"] {
  if (!tools || tools.length === 0) return undefined;
  // Hive's `ToolDef.inputSchema` is JSON Schema Draft 7. pi-ai expects a
  // typebox `TSchema`. `Type.Unsafe(rawJsonSchema)` is typebox's documented
  // entry point for "I have raw JSON Schema, treat it as a TSchema" — no
  // structural-cast escape hatches needed.
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: Type.Unsafe(t.inputSchema),
  }));
}

// Exported for tests: assert effort → reasoning mapping (incl. minimal/xhigh)
// without booting pi-ai.
export function translateThinking(t: CompletionInput["thinking"]):
  | {
      reasoning?: ThinkingLevel;
      thinkingBudgets?: ThinkingBudgets;
    }
  | undefined {
  if (!t) return undefined;
  const out: {
    reasoning?: ThinkingLevel;
    thinkingBudgets?: ThinkingBudgets;
  } = {};
  // Hive's non-"off" `ThinkingEffort` members ARE pi-ai's `ThinkingLevel`
  // (minimal|low|medium|high|xhigh) — `satisfies` proves it; no cast.
  if (t.effort && t.effort !== "off") {
    const level: ThinkingLevel = t.effort;
    out.reasoning = level;
  }
  // budgetTokens only applies to the budget-bearing levels pi-ai's
  // `ThinkingBudgets` declares (minimal|low|medium|high); `xhigh`/`off` carry
  // no budget slot, so skip them.
  if (
    t.budgetTokens !== undefined &&
    t.effort &&
    (t.effort === "minimal" || t.effort === "low" || t.effort === "medium" || t.effort === "high")
  ) {
    out.thinkingBudgets = { [t.effort]: t.budgetTokens };
  }
  return out.reasoning || out.thinkingBudgets ? out : undefined;
}

/**
 * Derive a model's supported thinking-effort levels from pi-ai's
 * `thinkingLevelMap`, in canonical `EFFORT_ORDER`. A non-"off" level is
 * supported when its key is present AND its value is non-null — pi-ai documents
 * `null` as "level unsupported" (Model.thinkingLevelMap), and a missing key
 * means "use provider default", which we don't surface as a user-selectable
 * level.
 *
 * "off" follows the same null-means-unsupported rule: a model that declares
 * `off: null` cannot disable reasoning (it always thinks), so offering "off"
 * would be a no-op — it is dropped. "off" is offered for every other model
 * (absent key or non-null value), so a model with no map (most non-reasoning
 * models) supports only "off".
 *
 * Exported for tests.
 */
export function effortsFromThinkingLevelMap(map: ThinkingLevelMap | undefined): ThinkingEffort[] {
  return EFFORT_ORDER.filter((level) => {
    const v = map?.[level];
    // null = explicitly unsupported (applies to every level, incl. "off": a
    // model that declares off:null cannot disable reasoning).
    if (v === null) return false;
    // "off" is offered whenever it isn't explicitly null — a model can run
    // without extra reasoning unless it declares it can't. Non-"off" levels
    // need an explicit non-null value (a missing key is a provider default we
    // don't surface).
    if (level === "off") return true;
    return v !== undefined;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Event translation: pi-ai → Hive GatewayEvent
// ─────────────────────────────────────────────────────────────────────────────

function mapStopReason(reason: PiStopReason): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "toolUse":
      return "tool_use";
    case "aborted":
      return "cancelled";
    case "error":
      return "error";
  }
}

export function classifyError(errorMessage: string | undefined): {
  code: GatewayErrorCode;
  retryable: boolean;
} {
  const m = (errorMessage ?? "").toLowerCase();
  if (m.includes("401") || m.includes("unauthor") || m.includes("invalid api key")) {
    return { code: "auth_failed", retryable: false };
  }
  if (m.includes("quota") || m.includes("billing")) {
    return { code: "quota_exceeded", retryable: false };
  }
  if (m.includes("429") || m.includes("rate limit")) {
    return { code: "rate_limited", retryable: true };
  }
  if (m.includes("529") || m.includes("overloaded")) {
    return { code: "model_overloaded", retryable: true };
  }
  if (m.includes("context length") || m.includes("too long") || m.includes("token limit")) {
    return { code: "context_too_long", retryable: false };
  }
  if (m.includes("model") && (m.includes("not found") || m.includes("does not exist"))) {
    return { code: "model_not_found", retryable: false };
  }
  if (m.includes("content policy") || m.includes("safety")) {
    return { code: "content_policy", retryable: false };
  }
  if (
    m.includes("timeout") ||
    m.includes("econnreset") ||
    m.includes("network") ||
    m.includes("fetch failed")
  ) {
    return { code: "network", retryable: true };
  }
  if (m.match(/\b5\d\d\b/) || m.includes("internal server")) {
    return { code: "server", retryable: true };
  }
  return { code: "unknown", retryable: false };
}

function extractToolCallFromPartial(
  partial: AssistantMessage,
  contentIndex: number,
): ToolCall | undefined {
  const block = partial.content[contentIndex];
  return block?.type === "toolCall" ? block : undefined;
}

function buildUsageEvent(
  usage: AssistantMessage["usage"],
): Extract<GatewayEvent, { type: "usage" }> {
  return {
    type: "usage",
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead && { cacheReadTokens: usage.cacheRead }),
    ...(usage.cacheWrite && { cacheWriteTokens: usage.cacheWrite }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth → apiKey resolution
// ─────────────────────────────────────────────────────────────────────────────

type OAuthCreds = { access: string; refresh: string; expires: number };

/**
 * Convert OAuth credentials into an apiKey usable by `streamSimple`. Calls
 * pi-ai's `getOAuthApiKey`, which automatically refreshes if the access
 * token is expired. When refresh produces new credentials, fires
 * `onRefresh(newCreds)` so the Secrets module can persist them — this is
 * how mid-call OAuth refresh round-trips back to disk per ADR-0005
 * §AuthInput.
 *
 * Returns `null` when pi-ai cannot produce a usable apiKey (provider
 * doesn't implement OAuth or credentials are malformed past recovery).
 *
 * Exported for tests.
 */
export async function resolveOAuthApiKey(
  provider: string,
  credentials: OAuthCreds,
  onRefresh: (newCreds: OAuthCreds) => Promise<void>,
  apiKeyResolver: typeof getOAuthApiKey = getOAuthApiKey,
): Promise<string | null> {
  const result = await apiKeyResolver(provider, { [provider]: credentials });
  if (!result) return null;
  // pi-ai's `newCredentials` is the refreshed set if the access token had
  // expired, otherwise identical to the input. Detect "actually refreshed"
  // by comparing the access string — same value means no on-disk write
  // is needed.
  if (result.newCredentials.access !== credentials.access) {
    await onRefresh({
      access: result.newCredentials.access,
      refresh: result.newCredentials.refresh,
      expires: result.newCredentials.expires,
    });
  }
  return result.apiKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export function createPiAiAdapter(): GatewayAdapter {
  return {
    providers: PI_AI_PROVIDERS as unknown as string[],
    complete,
    listModels: (provider) => {
      if (!isPiProvider(provider)) return [];
      // Newest-first. pi-ai's Model carries no release date, so this is a
      // best-effort version-descending sort by id (numeric-aware, so 5.10 > 5.9).
      return getModels(provider)
        .map((m) => ({ id: m.id, efforts: effortsFromThinkingLevelMap(m.thinkingLevelMap) }))
        .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    },
  };
}

async function* complete(input: CompletionInput): AsyncIterable<GatewayEvent> {
  // 1. Parse model id.
  const slash = input.model.indexOf("/");
  if (slash < 1 || slash === input.model.length - 1) {
    yield {
      type: "error",
      code: "invalid_request",
      message: `model must be "provider/model"; got: ${JSON.stringify(input.model)}`,
      retryable: false,
    };
    yield { type: "done", finishReason: "error" };
    return;
  }
  const provider = input.model.slice(0, slash);
  const modelId = input.model.slice(slash + 1);
  if (!isPiProvider(provider)) {
    yield {
      type: "error",
      code: "model_not_found",
      message: `pi-ai adapter does not handle provider: ${provider}`,
      retryable: false,
    };
    yield { type: "done", finishReason: "error" };
    return;
  }

  // 2. Auth. apiKey is a straight pass-through; OAuth resolves via
  //    pi-ai's `getOAuthApiKey`, which refreshes expired tokens and
  //    fires `auth.onRefresh(newCreds)` so the Secrets module persists.
  //    Mid-stream expiry (the new token also expires before the stream
  //    finishes) is not handled in v1 — surfaces as a pi-ai error event.
  let apiKey: string;
  if (input.auth.kind === "apiKey") {
    apiKey = input.auth.apiKey;
  } else {
    const { credentials, onRefresh } = input.auth;
    let resolved: string | null;
    try {
      resolved = await resolveOAuthApiKey(provider, credentials, onRefresh);
    } catch (err) {
      yield {
        type: "error",
        code: "auth_failed",
        message: `OAuth refresh failed for "${provider}": ${(err as Error).message}`,
        retryable: false,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }
    if (!resolved) {
      yield {
        type: "error",
        code: "auth_failed",
        message: `OAuth resolution returned no apiKey for "${provider}"`,
        retryable: false,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }
    apiKey = resolved;
  }

  // 3. Resolve model. pi-ai's `getModel(provider, modelId)` is statically
  //    typed on literal (provider, modelId) pairs; at runtime we have plain
  //    strings. `getModels(provider)` enumerates the registry without the
  //    deep literal-narrowing — find by id ourselves and surface a clean
  //    `model_not_found` if absent.
  //    `isPiProvider` already proved `provider` is a member of
  //    `PI_AI_PROVIDERS`; every entry there is a `KnownProvider`, so the
  //    cast is honest.
  const piProvider = provider as KnownProvider;
  let model: Model<Api>;
  try {
    const candidates = getModels(piProvider);
    const found = candidates.find((m) => m.id === modelId);
    if (!found) {
      yield {
        type: "error",
        code: "model_not_found",
        message: `pi-ai: no model "${modelId}" registered for provider "${provider}"`,
        retryable: false,
      };
      yield { type: "done", finishReason: "error" };
      return;
    }
    model = found;
  } catch (err) {
    yield {
      type: "error",
      code: "model_not_found",
      message: `pi-ai: model lookup failed for "${input.model}": ${(err as Error).message}`,
      retryable: false,
    };
    yield { type: "done", finishReason: "error" };
    return;
  }

  // 4. Build pi-ai Context.
  const context: Context = {
    ...(input.system && { systemPrompt: input.system }),
    messages: translateMessages(input.messages),
    ...((tools) => (tools ? { tools } : {}))(translateTools(input.tools)),
  };

  // 5. Build pi-ai options.
  const thinkingOpts = translateThinking(input.thinking);
  const providerHints = input.providerHints?.["pi-ai"];
  const hintOverrides =
    providerHints && typeof providerHints === "object"
      ? (providerHints as Record<string, unknown>)
      : {};

  const piOptions = {
    apiKey,
    ...(input.signal && { signal: input.signal }),
    ...(input.limits?.maxTokens !== undefined && { maxTokens: input.limits.maxTokens }),
    ...(input.limits?.temperature !== undefined && { temperature: input.limits.temperature }),
    ...thinkingOpts,
    ...hintOverrides,
  };

  // 6. Stream + translate.
  let stream: AsyncIterable<AssistantMessageEvent>;
  try {
    stream = streamSimple(model, context, piOptions) as AsyncIterable<AssistantMessageEvent>;
  } catch (err) {
    // pi-ai surfaces async failures via its `error` event, but a synchronous
    // setup throw (bad apiKey shape, registry missing, …) lands here.
    const { code, retryable } = classifyError((err as Error).message);
    yield {
      type: "error",
      code,
      message: `pi-ai stream failed: ${(err as Error).message}`,
      retryable,
    };
    yield { type: "done", finishReason: "error" };
    return;
  }

  yield* translatePiAiStream(stream, input.signal);
}

/**
 * Pure pi-ai → GatewayEvent translator. Exported for tests: feed a hand-crafted
 * `AsyncIterable<AssistantMessageEvent>` and assert the emitted GatewayEvents
 * without booting pi-ai.
 *
 * Guarantees:
 * - Emits exactly one `done` and at most one `usage` (before `done`).
 * - On `signal.aborted`, ends with `done(cancelled)` and no further events.
 * - On pi-ai `error` event with `reason: "aborted"`, ends with `done(cancelled)`.
 * - On pi-ai stream ending without a terminal event, emits `error(unknown)` + `done(error)`.
 */
export async function* translatePiAiStream(
  source: AsyncIterable<AssistantMessageEvent>,
  signal?: AbortSignal,
): AsyncIterable<GatewayEvent> {
  const state: EventState = {
    textStarted: new Set<number>(),
    thinkingStarted: new Set<number>(),
    toolStarted: new Map<number, { id: string; name: string }>(),
  };

  try {
    for await (const ev of source) {
      if (signal?.aborted) {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      for (const out of translateEvent(ev, state)) {
        yield out;
      }
      if (ev.type === "done" || ev.type === "error") {
        const final = ev.type === "done" ? ev.message : ev.error;
        if (final.usage.input > 0 || final.usage.output > 0) {
          yield buildUsageEvent(final.usage);
        }
        if (signal?.aborted || (ev.type === "error" && ev.reason === "aborted")) {
          yield { type: "done", finishReason: "cancelled" };
        } else if (ev.type === "error") {
          yield { type: "done", finishReason: "error" };
        } else {
          yield { type: "done", finishReason: mapStopReason(ev.reason) };
        }
        return;
      }
    }
  } catch (err) {
    const { code, retryable } = classifyError((err as Error).message);
    yield {
      type: "error",
      code,
      message: `pi-ai stream failed: ${(err as Error).message}`,
      retryable,
    };
    yield { type: "done", finishReason: "error" };
    return;
  }

  if (signal?.aborted) {
    yield { type: "done", finishReason: "cancelled" };
    return;
  }
  // Stream ended without a terminal event — pi-ai contract violation, but
  // we must always emit `done`.
  yield {
    type: "error",
    code: "unknown",
    message: "pi-ai stream ended without a terminal event",
    retryable: false,
  };
  yield { type: "done", finishReason: "error" };
}

type EventState = {
  textStarted: Set<number>;
  thinkingStarted: Set<number>;
  toolStarted: Map<number, { id: string; name: string }>;
};

function translateEvent(ev: AssistantMessageEvent, state: EventState): GatewayEvent[] {
  switch (ev.type) {
    case "start":
      return [];
    case "text_start":
      state.textStarted.add(ev.contentIndex);
      return [{ type: "text_start", blockIndex: ev.contentIndex }];
    case "text_delta":
      return [{ type: "text_delta", blockIndex: ev.contentIndex, delta: ev.delta }];
    case "text_end":
      return [{ type: "text_end", blockIndex: ev.contentIndex }];
    case "thinking_start":
      state.thinkingStarted.add(ev.contentIndex);
      return [{ type: "thinking_start", blockIndex: ev.contentIndex }];
    case "thinking_delta":
      return [{ type: "thinking_delta", blockIndex: ev.contentIndex, delta: ev.delta }];
    case "thinking_end": {
      // Recover provider signature from the partial assistant message.
      const block = ev.partial.content[ev.contentIndex];
      const sig =
        block?.type === "thinking" && block.thinkingSignature ? block.thinkingSignature : undefined;
      return [
        {
          type: "thinking_end",
          blockIndex: ev.contentIndex,
          ...(sig && { providerMetadata: { signature: sig } }),
        },
      ];
    }
    case "toolcall_start": {
      // pi-ai doesn't carry id/name on toolcall_start; recover from partial.
      const tc = extractToolCallFromPartial(ev.partial, ev.contentIndex);
      if (!tc) {
        // pi-ai bug or schema drift — surface and skip rather than crash.
        return [
          {
            type: "error",
            code: "unknown",
            message: `pi-ai toolcall_start without ToolCall at contentIndex=${ev.contentIndex}`,
            retryable: false,
          },
        ];
      }
      state.toolStarted.set(ev.contentIndex, { id: tc.id, name: tc.name });
      return [{ type: "tool_use_start", blockIndex: ev.contentIndex, id: tc.id, name: tc.name }];
    }
    case "toolcall_delta": {
      const meta = state.toolStarted.get(ev.contentIndex);
      if (!meta) return []; // delta before start — drop defensively
      return [
        {
          type: "tool_use_delta",
          blockIndex: ev.contentIndex,
          id: meta.id,
          delta: ev.delta,
        },
      ];
    }
    case "toolcall_end":
      return [
        {
          type: "tool_use_end",
          blockIndex: ev.contentIndex,
          id: ev.toolCall.id,
          args: ev.toolCall.arguments,
        },
      ];
    case "error": {
      const { code, retryable } = classifyError(ev.error.errorMessage);
      return [
        {
          type: "error",
          code,
          message: ev.error.errorMessage ?? "pi-ai reported error without message",
          retryable,
        },
      ];
    }
    case "done":
      return [];
  }
}
