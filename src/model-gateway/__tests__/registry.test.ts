import { afterEach, describe, expect, test } from "bun:test";
import { GatewayError } from "../errors.ts";
import { _resetRegistry, registerAdapter, resolve } from "../registry.ts";
import type { GatewayAdapter } from "../types.ts";

const stub: GatewayAdapter = {
  providers: ["fake", "other"],
  async *complete() {
    yield { type: "done", finishReason: "stop" };
  },
};

describe("registry", () => {
  afterEach(() => {
    _resetRegistry();
  });

  test("resolves a registered provider", () => {
    registerAdapter(stub);
    expect(resolve("fake/anything")).toBe(stub);
    expect(resolve("other/x")).toBe(stub);
  });

  test("throws model_not_found for unknown provider", () => {
    registerAdapter(stub);
    try {
      resolve("unknown/model");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("model_not_found");
    }
  });

  test("throws invalid_request for malformed model string", () => {
    registerAdapter(stub);
    for (const bad of ["", "no-slash", "/leading", "trailing/"]) {
      try {
        resolve(bad);
        throw new Error(`expected throw for: ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).code).toBe("invalid_request");
      }
    }
  });

  test("last registration wins for a given provider key", () => {
    const a: GatewayAdapter = { providers: ["x"], async *complete() {} };
    const b: GatewayAdapter = { providers: ["x"], async *complete() {} };
    registerAdapter(a);
    registerAdapter(b);
    expect(resolve("x/m")).toBe(b);
  });
});
