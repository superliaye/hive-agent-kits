import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { makeFakeAdapter } from "../adapters/fake.ts";
import { createGatewayRegistry } from "../registry.ts";
import type { CompletionInput, GatewayAdapter } from "../types.ts";
import { completeStream } from "./complete.ts";
import { GatewayFailure } from "./failure.ts";

function input(model: string): CompletionInput {
  return { model, messages: [], auth: { kind: "apiKey", apiKey: "test" } };
}

describe("completeStream", () => {
  test("passes a scripted adapter stream through as a typed Stream", async () => {
    const r = createGatewayRegistry();
    r.registerAdapter(
      makeFakeAdapter(["fake"], {
        "fake/echo": [
          { type: "text_start", blockIndex: 0 },
          { type: "text_delta", blockIndex: 0, delta: "hi" },
          { type: "done", finishReason: "stop" },
        ],
      }),
    );
    const collected = await Effect.runPromise(
      Stream.runCollect(completeStream(r, input("fake/echo"))),
    );
    expect(collected.map((e) => e.type)).toEqual(["text_start", "text_delta", "done"]);
  });

  test("fails with GatewayFailure(model_not_found) when no adapter resolves", async () => {
    const r = createGatewayRegistry();
    const failure = await Effect.runPromise(
      Effect.flip(Stream.runDrain(completeStream(r, input("nope/x")))),
    );
    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure.code).toBe("model_not_found");
  });

  test("maps a thrown adapter error into the typed E channel", async () => {
    const r = createGatewayRegistry();
    const throwing: GatewayAdapter = {
      providers: ["boom"],
      complete() {
        return {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(new Error("kaboom")) };
          },
        };
      },
    };
    r.registerAdapter(throwing);
    const failure = await Effect.runPromise(
      Effect.flip(Stream.runDrain(completeStream(r, input("boom/x")))),
    );
    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure.code).toBe("unknown");
    expect(failure.message).toContain("kaboom");
  });
});
