import { describe, expect, test } from "bun:test";
import { Stream } from "effect";
import { streamToAsyncIterable } from "./effect-interop.ts";

describe("streamToAsyncIterable", () => {
  test("round-trips a succeeding stream", async () => {
    const out: number[] = [];
    for await (const n of streamToAsyncIterable(Stream.fromIterable([1, 2, 3]), () => [-1])) {
      out.push(n);
    }
    expect(out).toEqual([1, 2, 3]);
  });

  test("maps a typed failure to a terminal element instead of throwing", async () => {
    const failing = Stream.fromIterable([1, 2]).pipe(Stream.concat(Stream.fail("boom" as const)));
    const out: number[] = [];
    for await (const n of streamToAsyncIterable(failing, () => [99])) {
      out.push(n);
    }
    expect(out).toEqual([1, 2, 99]);
  });
});
