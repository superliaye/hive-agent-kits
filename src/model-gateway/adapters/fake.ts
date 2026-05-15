// Fake adapter — emits a scripted GatewayEvent fixture.
//
// Two roles:
//   1. Makes the adapter seam real (two adapters > one).
//   2. Lets callers test their consumption logic without network or subprocesses.
//
// Usage:
//   registerAdapter(makeFakeAdapter(["fake"], {
//     "fake/echo": [{type: "text_start", blockIndex: 0}, ...]
//   }));

import type { CompletionInput, GatewayAdapter, GatewayEvent } from "../types.ts";

export type FakeScript = GatewayEvent[] | ((input: CompletionInput) => GatewayEvent[]);

export type FakeFixtures = Record<string, FakeScript>;

export function makeFakeAdapter(providers: string[], fixtures: FakeFixtures): GatewayAdapter {
  return {
    providers,
    async *complete(input: CompletionInput): AsyncIterable<GatewayEvent> {
      const script = fixtures[input.model];
      if (!script) {
        yield {
          type: "error",
          code: "model_not_found",
          message: `fake adapter has no fixture for model: ${input.model}`,
          retryable: false,
        };
        yield { type: "done", finishReason: "error" };
        return;
      }
      const events = typeof script === "function" ? script(input) : script;
      for (const event of events) {
        if (input.signal?.aborted) {
          yield { type: "done", finishReason: "cancelled" };
          return;
        }
        yield event;
      }
    },
  };
}
