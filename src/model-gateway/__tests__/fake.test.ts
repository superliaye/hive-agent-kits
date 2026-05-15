import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeAdapter } from "../adapters/fake.ts";
import { complete } from "../index.ts";
import { _resetRegistry, registerAdapter } from "../registry.ts";
import type { GatewayEvent } from "../types.ts";

describe("fake adapter", () => {
  afterEach(() => {
    _resetRegistry();
  });

  test("emits scripted events in order", async () => {
    const script: GatewayEvent[] = [
      { type: "text_start", blockIndex: 0 },
      { type: "text_delta", blockIndex: 0, delta: "hello " },
      { type: "text_delta", blockIndex: 0, delta: "world" },
      { type: "text_end", blockIndex: 0 },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", finishReason: "stop" },
    ];
    registerAdapter(makeFakeAdapter(["fake"], { "fake/echo": script }));

    const got: GatewayEvent[] = [];
    for await (const ev of complete({
      model: "fake/echo",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: { kind: "apiKey", apiKey: "" },
    })) {
      got.push(ev);
    }
    expect(got).toEqual(script);
  });

  test("emits error + done when fixture is missing", async () => {
    registerAdapter(makeFakeAdapter(["fake"], {}));
    const got: GatewayEvent[] = [];
    for await (const ev of complete({
      model: "fake/missing",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: { kind: "apiKey", apiKey: "" },
    })) {
      got.push(ev);
    }
    expect(got).toHaveLength(2);
    expect(got[0]?.type).toBe("error");
    expect(got[1]).toEqual({ type: "done", finishReason: "error" });
  });

  test("exercises the full GatewayEvent union", async () => {
    // Canonical exhaustive fixture — one event per variant, in order.
    const script: GatewayEvent[] = [
      { type: "thinking_start", blockIndex: 0 },
      { type: "thinking_delta", blockIndex: 0, delta: "thinking..." },
      {
        type: "thinking_end",
        blockIndex: 0,
        providerMetadata: { signature: "sig" },
      },
      { type: "text_start", blockIndex: 1 },
      { type: "text_delta", blockIndex: 1, delta: "answer" },
      { type: "text_end", blockIndex: 1 },
      { type: "refusal_delta", delta: "I cannot..." },
      { type: "tool_use_start", blockIndex: 2, id: "tu_1", name: "search" },
      { type: "tool_use_delta", blockIndex: 2, id: "tu_1", delta: '{"q":' },
      { type: "tool_use_end", blockIndex: 2, id: "tu_1", args: { q: "x" } },
      {
        type: "server_tool",
        blockIndex: 3,
        id: "st_1",
        name: "web_search",
        phase: "start",
      },
      {
        type: "server_tool",
        blockIndex: 3,
        id: "st_1",
        name: "web_search",
        phase: "result",
        payload: { hits: 0 },
      },
      {
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 3,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      },
      { type: "done", finishReason: "tool_use" },
    ];
    registerAdapter(makeFakeAdapter(["fake"], { "fake/full": script }));

    const got: GatewayEvent[] = [];
    for await (const ev of complete({
      model: "fake/full",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      auth: { kind: "apiKey", apiKey: "" },
    })) {
      got.push(ev);
    }
    expect(got).toEqual(script);
  });

  test("honors AbortSignal mid-stream", async () => {
    const script: GatewayEvent[] = [
      { type: "text_start", blockIndex: 0 },
      { type: "text_delta", blockIndex: 0, delta: "a" },
      { type: "text_delta", blockIndex: 0, delta: "b" },
      { type: "done", finishReason: "stop" },
    ];
    registerAdapter(makeFakeAdapter(["fake"], { "fake/echo": script }));
    const ctrl = new AbortController();
    const got: GatewayEvent[] = [];
    for await (const ev of complete({
      model: "fake/echo",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      auth: { kind: "apiKey", apiKey: "" },
      signal: ctrl.signal,
    })) {
      got.push(ev);
      if (got.length === 2) ctrl.abort();
    }
    expect(got[got.length - 1]).toEqual({ type: "done", finishReason: "cancelled" });
  });
});
