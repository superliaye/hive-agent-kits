import { describe, expect, test } from "bun:test";
import { GatewayError } from "../errors.ts";
import { createGatewayRegistry } from "../registry.ts";
import type { GatewayAdapter } from "../types.ts";

const stub: GatewayAdapter = {
  providers: ["fake", "other"],
  async *complete() {
    yield { type: "done", finishReason: "stop" };
  },
};

describe("registry", () => {
  test("resolves a registered provider", () => {
    const r = createGatewayRegistry();
    r.registerAdapter(stub);
    expect(r.resolve("fake/anything")).toBe(stub);
    expect(r.resolve("other/x")).toBe(stub);
  });

  test("throws model_not_found for unknown provider", () => {
    const r = createGatewayRegistry();
    r.registerAdapter(stub);
    try {
      r.resolve("unknown/model");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("model_not_found");
    }
  });

  test("throws invalid_request for malformed model string", () => {
    const r = createGatewayRegistry();
    r.registerAdapter(stub);
    for (const bad of ["", "no-slash", "/leading", "trailing/"]) {
      try {
        r.resolve(bad);
        throw new Error(`expected throw for: ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).code).toBe("invalid_request");
      }
    }
  });

  test("last registration wins for a given provider key", () => {
    const r = createGatewayRegistry();
    const a: GatewayAdapter = { providers: ["x"], async *complete() {} };
    const b: GatewayAdapter = { providers: ["x"], async *complete() {} };
    r.registerAdapter(a);
    r.registerAdapter(b);
    expect(r.resolve("x/m")).toBe(b);
  });

  test("disposer unregisters the adapter and emits adapter.unregistered", async () => {
    const r = createGatewayRegistry();
    const events: Array<{ type: string; providers: readonly string[] }> = [];
    r.events.on("adapter.registered", (e) => {
      events.push({ type: "registered", providers: e.providers });
    });
    r.events.on("adapter.unregistered", (e) => {
      events.push({ type: "unregistered", providers: e.providers });
    });

    const dispose = r.registerAdapter(stub);
    expect(r.resolve("fake/m")).toBe(stub);
    dispose();
    try {
      r.resolve("fake/m");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as GatewayError).code).toBe("model_not_found");
    }

    // Allow microtasks to flush.
    await Promise.resolve();
    expect(events).toEqual([
      { type: "registered", providers: ["fake", "other"] },
      { type: "unregistered", providers: ["fake", "other"] },
    ]);
  });
});
