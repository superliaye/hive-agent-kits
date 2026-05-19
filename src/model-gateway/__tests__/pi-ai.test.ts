import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import {
  classifyError,
  createPiAiAdapter,
  translateMessages,
  translatePiAiStream,
} from "../adapters/pi-ai.ts";
import { createGateway } from "../index.ts";
import type { GatewayEvent, Message } from "../types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function finalMsg(
  partial: Partial<AssistantMessage>,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-7",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: 0,
    ...partial,
  };
}

async function* fromArray(events: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
  for (const ev of events) yield ev;
}

async function collect(stream: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ─── classifyError ──────────────────────────────────────────────────────────

describe("classifyError", () => {
  test.each([
    ["401 Unauthorized", "auth_failed", false],
    ["Invalid API key", "auth_failed", false],
    ["You have exceeded your quota", "quota_exceeded", false],
    ["billing issue detected", "quota_exceeded", false],
    ["429 Too Many Requests", "rate_limited", true],
    ["rate limit reached", "rate_limited", true],
    ["overloaded_error (529)", "model_overloaded", true],
    ["context length exceeded", "context_too_long", false],
    ["model does not exist", "model_not_found", false],
    ["blocked by content policy", "content_policy", false],
    ["network timeout", "network", true],
    ["fetch failed", "network", true],
    ["internal server error 503", "server", true],
    ["weird thing happened", "unknown", false],
  ])("classifies %p", (msg, expectedCode, expectedRetryable) => {
    const { code, retryable } = classifyError(msg);
    expect(code).toBe(expectedCode as never);
    expect(retryable).toBe(expectedRetryable);
  });

  test("undefined message → unknown", () => {
    const { code, retryable } = classifyError(undefined);
    expect(code).toBe("unknown");
    expect(retryable).toBe(false);
  });
});

// ─── translateMessages ──────────────────────────────────────────────────────

describe("translateMessages", () => {
  test("simple user text", () => {
    const out = translateMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
    if (out[0]?.role === "user") {
      expect(out[0].content).toEqual([{ type: "text", text: "hi" }]);
    }
  });

  test("splits user message with tool_result blocks into UserMessage + ToolResultMessage", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "result text" },
          { type: "text", text: "follow-up question" },
        ],
      },
    ];
    const out = translateMessages(msgs);
    // Expected order: assistant, user(text), toolResult
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("user");
    expect(out[2]?.role).toBe("toolResult");
    if (out[2]?.role === "toolResult") {
      expect(out[2].toolCallId).toBe("tu_1");
      expect(out[2].toolName).toBe("search");
      expect(out[2].content).toEqual([{ type: "text", text: "result text" }]);
      expect(out[2].isError).toBe(false);
    }
  });

  test("tool_result for unknown tool_use_id falls back to a text marker", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }],
      },
    ]);
    // No prior tool_use → no toolResult message, just a text user message
    // containing the marker.
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
    if (out[0]?.role === "user") {
      expect(JSON.stringify(out[0].content)).toContain("tool_result for unknown tool_use_id=missing");
    }
  });

  test("assistant thinking + tool_use blocks survive the roundtrip", () => {
    const out = translateMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me see", signature: "sig-1" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tu_2", name: "fetch", input: { url: "x" } },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    if (out[0]?.role === "assistant") {
      expect(out[0].content[0]).toEqual({
        type: "thinking",
        thinking: "let me see",
        thinkingSignature: "sig-1",
      });
      expect(out[0].content[1]).toEqual({ type: "text", text: "answer" });
      expect(out[0].content[2]).toEqual({
        type: "toolCall",
        id: "tu_2",
        name: "fetch",
        arguments: { url: "x" },
      });
    }
  });
});

// ─── translatePiAiStream ────────────────────────────────────────────────────

describe("translatePiAiStream — happy paths", () => {
  test("text-only stream emits text events, usage, done(stop)", async () => {
    const partial = finalMsg({});
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "start", partial },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: "hello ", partial },
          { type: "text_delta", contentIndex: 0, delta: "world", partial },
          { type: "text_end", contentIndex: 0, content: "hello world", partial },
          {
            type: "done",
            reason: "stop",
            message: finalMsg({ usage: { ...ZERO_USAGE, input: 3, output: 2, totalTokens: 5 } }),
          },
        ]),
      ),
    );
    expect(got).toEqual([
      { type: "text_start", blockIndex: 0 },
      { type: "text_delta", blockIndex: 0, delta: "hello " },
      { type: "text_delta", blockIndex: 0, delta: "world" },
      { type: "text_end", blockIndex: 0 },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", finishReason: "stop" },
    ]);
  });

  test("thinking_end recovers signature from partial", async () => {
    const thinkingBlock = { type: "thinking" as const, thinking: "x", thinkingSignature: "sig-2" };
    const partial = finalMsg({ content: [thinkingBlock] });
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "thinking_start", contentIndex: 0, partial },
          { type: "thinking_delta", contentIndex: 0, delta: "x", partial },
          { type: "thinking_end", contentIndex: 0, content: "x", partial },
          { type: "done", reason: "stop", message: finalMsg({ content: [thinkingBlock] }) },
        ]),
      ),
    );
    const thinkingEnd = got.find((e) => e.type === "thinking_end");
    expect(thinkingEnd).toEqual({
      type: "thinking_end",
      blockIndex: 0,
      providerMetadata: { signature: "sig-2" },
    });
  });

  test("tool_use_start recovers id+name from partial; delta + end propagate", async () => {
    const tc = { type: "toolCall" as const, id: "tu_1", name: "search", arguments: {} };
    const partial = finalMsg({ content: [tc] });
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "toolcall_start", contentIndex: 0, partial },
          { type: "toolcall_delta", contentIndex: 0, delta: '{"q":', partial },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: { type: "toolCall", id: "tu_1", name: "search", arguments: { q: "x" } },
            partial: finalMsg({
              content: [{ type: "toolCall", id: "tu_1", name: "search", arguments: { q: "x" } }],
            }),
          },
          {
            type: "done",
            reason: "toolUse",
            message: finalMsg({
              content: [{ type: "toolCall", id: "tu_1", name: "search", arguments: { q: "x" } }],
              stopReason: "toolUse",
            }),
          },
        ]),
      ),
    );
    expect(got.filter((e) => e.type.startsWith("tool_use"))).toEqual([
      { type: "tool_use_start", blockIndex: 0, id: "tu_1", name: "search" },
      { type: "tool_use_delta", blockIndex: 0, id: "tu_1", delta: '{"q":' },
      { type: "tool_use_end", blockIndex: 0, id: "tu_1", args: { q: "x" } },
    ]);
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "tool_use" });
  });

  test("emits usage only when token counts are non-zero", async () => {
    const partial = finalMsg({});
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_end", contentIndex: 0, content: "", partial },
          { type: "done", reason: "stop", message: finalMsg({}) }, // zero usage
        ]),
      ),
    );
    expect(got.find((e) => e.type === "usage")).toBeUndefined();
  });
});

describe("translatePiAiStream — edge cases", () => {
  test("toolcall_delta before toolcall_start is dropped defensively", async () => {
    const partial = finalMsg({});
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "toolcall_delta", contentIndex: 0, delta: "{", partial },
          { type: "done", reason: "stop", message: finalMsg({}) },
        ]),
      ),
    );
    expect(got.filter((e) => e.type === "tool_use_delta")).toHaveLength(0);
  });

  test("toolcall_start without ToolCall at partial[contentIndex] emits unknown error", async () => {
    const partial = finalMsg({}); // empty content
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "toolcall_start", contentIndex: 0, partial },
          { type: "done", reason: "stop", message: finalMsg({}) },
        ]),
      ),
    );
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("unknown");
      expect(err.message).toContain("contentIndex=0");
    }
  });

  test("pi-ai error event maps to error + done(error)", async () => {
    const partial = finalMsg({});
    const errMsg = finalMsg({ errorMessage: "401 unauthorized", stopReason: "error" }, "error");
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "text_start", contentIndex: 0, partial },
          { type: "error", reason: "error", error: errMsg },
        ]),
      ),
    );
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("auth_failed");
      expect(err.retryable).toBe(false);
    }
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "error" });
  });

  test("pi-ai error event with reason='aborted' ends with done(cancelled)", async () => {
    const partial = finalMsg({});
    const errMsg = finalMsg({ stopReason: "aborted" }, "aborted");
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "text_start", contentIndex: 0, partial },
          { type: "error", reason: "aborted", error: errMsg },
        ]),
      ),
    );
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "cancelled" });
  });

  test("AbortSignal aborted before iteration starts ends with done(cancelled)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const partial = finalMsg({});
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "text_start", contentIndex: 0, partial },
          { type: "done", reason: "stop", message: finalMsg({}) },
        ]),
        ctrl.signal,
      ),
    );
    expect(got).toEqual([{ type: "done", finishReason: "cancelled" }]);
  });

  test("stream ends without terminal event → error(unknown) + done(error)", async () => {
    const partial = finalMsg({});
    const got = await collect(
      translatePiAiStream(
        fromArray([
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: "x", partial },
          // no done, no error
        ]),
      ),
    );
    expect(got[got.length - 2]?.type).toBe("error");
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "error" });
    const err = got[got.length - 2];
    if (err?.type === "error") {
      expect(err.code).toBe("unknown");
    }
  });

  test("source throwing mid-stream is caught and emits error + done(error)", async () => {
    async function* throws(): AsyncIterable<AssistantMessageEvent> {
      yield { type: "start", partial: finalMsg({}) };
      throw new Error("network timeout");
    }
    const got = await collect(translatePiAiStream(throws()));
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("network");
      expect(err.retryable).toBe(true);
    }
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "error" });
  });
});

// ─── adapter.complete() short-circuit paths ─────────────────────────────────

describe("pi-ai adapter — short-circuit paths", () => {
  // Gateway-level malformed-model handling is covered in registry.test.ts.
  // Here we verify the adapter's own parse path: a string the registry
  // accepts (`<provider>/<model>`) but where the adapter detects shape
  // problems.
  test("adapter parses model and surfaces invalid_request for trailing slash", async () => {
    // Registry rejects "anthropic/" before the adapter; test the adapter
    // directly by feeding a problematic but registry-passable input.
    // Here we use a leading-slash bypass: the registry only catches
    // slash<1 OR slash===len-1. Anything past that the adapter handles.
    // Since the registry catches the obvious malformed cases, the adapter's
    // own guard is defensive belt-and-suspenders; assert it short-circuits
    // when called directly with such input.
    const adapter = createPiAiAdapter();
    const got: GatewayEvent[] = [];
    for await (const ev of adapter.complete({
      model: "/no-provider",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: { kind: "apiKey", apiKey: "x" },
    })) {
      got.push(ev);
    }
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("invalid_request");
    }
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "error" });
  });

  test("OAuth auth surfaces auth_failed", async () => {
    const adapter = createPiAiAdapter();
    const got: GatewayEvent[] = [];
    for await (const ev of adapter.complete({
      model: "anthropic/claude-opus-4-7",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: {
        kind: "oauth",
        credentials: { access: "a", refresh: "r", expires: 0 },
        onRefresh: async () => {},
      },
    })) {
      got.push(ev);
    }
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("auth_failed");
      expect(err.message.toLowerCase()).toContain("oauth");
    }
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "error" });
  });

  test("unknown provider not in pi-ai provider list → model_not_found", async () => {
    const adapter = createPiAiAdapter();
    const got: GatewayEvent[] = [];
    for await (const ev of adapter.complete({
      model: "unknown-vendor/some-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: { kind: "apiKey", apiKey: "x" },
    })) {
      got.push(ev);
    }
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("model_not_found");
    }
  });

  test("known provider, unknown model id → model_not_found", async () => {
    const adapter = createPiAiAdapter();
    const got: GatewayEvent[] = [];
    for await (const ev of adapter.complete({
      model: "anthropic/this-model-does-not-exist-9999",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: { kind: "apiKey", apiKey: "x" },
    })) {
      got.push(ev);
    }
    const err = got.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("model_not_found");
    }
  });
});

// ─── smoke test (real Anthropic call, skipped without key) ──────────────────

describe("pi-ai adapter (smoke)", () => {
  test("real Anthropic call emits text + usage + done(stop)", async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("[pi-ai.smoke] ANTHROPIC_API_KEY not set — skipping");
      return;
    }
    const gw = createGateway();
    gw.registerAdapter(createPiAiAdapter());

    const events: GatewayEvent[] = [];
    let text = "";
    for await (const ev of gw.complete({
      model: "anthropic/claude-haiku-4-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply with one word: HELLO" }] },
      ],
      auth: { kind: "apiKey", apiKey },
      limits: { maxTokens: 32 },
    })) {
      events.push(ev);
      if (ev.type === "text_delta") text += ev.delta;
    }

    console.log("[pi-ai.smoke] collected text:", JSON.stringify(text));
    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("usage");
    const last = events[events.length - 1];
    expect(last?.type).toBe("done");
    if (last?.type === "done") expect(last.finishReason).toBe("stop");
    expect(text.toUpperCase()).toContain("HELLO");
  }, 60_000);
});
