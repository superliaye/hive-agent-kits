import { describe, expect, test } from "bun:test";
import { deepEquals, deepMerge } from "../utils.ts";

describe("deepMerge", () => {
  test("user values override defaults at the same key", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 99 })).toEqual({ a: 1, b: 99 });
  });

  test("recurses into nested objects without losing default keys", () => {
    const out = deepMerge(
      { audit: { retention: { autoRotate: false, days: 90 } } },
      { audit: { retention: { days: 30 } } },
    );
    expect(out).toEqual({ audit: { retention: { autoRotate: false, days: 30 } } });
  });

  test("user-supplied missing leaves keep default values", () => {
    const out = deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 10 } });
    expect(out).toEqual({ a: { b: 10, c: 2 } });
  });

  test("arrays are replaced wholesale, not merged element-wise", () => {
    expect(deepMerge({ items: [1, 2, 3] }, { items: [99] })).toEqual({ items: [99] });
  });

  test("non-object user value replaces the default branch", () => {
    const out = deepMerge<{ a: unknown }>({ a: { b: 1 } }, { a: "literal" });
    expect(out).toEqual({ a: "literal" });
  });

  test("undefined user value falls back to default", () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});

describe("deepEquals", () => {
  test("primitives", () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals("x", "x")).toBe(true);
    expect(deepEquals(true, false)).toBe(false);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(null, undefined)).toBe(false);
  });

  test("flat objects", () => {
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEquals({ a: 1 }, { a: 2 })).toBe(false);
  });

  test("nested objects", () => {
    expect(deepEquals({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
    expect(deepEquals({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  test("arrays", () => {
    expect(deepEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEquals([1, 2, 3], [3, 2, 1])).toBe(false);
  });
});
