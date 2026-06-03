import { describe, expect, test } from "bun:test";
import { GatewayFailure, toErrorEvent } from "./failure.ts";

describe("GatewayFailure", () => {
  test("derives retryable from the code and maps to the in-band error event losslessly", () => {
    const f = new GatewayFailure({ code: "rate_limited", message: "slow down" });
    expect(f._tag).toBe("GatewayFailure");
    expect(f.retryable).toBe(true);
    expect(toErrorEvent(f)).toEqual({
      type: "error",
      code: "rate_limited",
      message: "slow down",
      retryable: true,
    });
  });

  test("non-retryable code maps with retryable=false", () => {
    const f = new GatewayFailure({ code: "auth_failed", message: "bad key" });
    expect(f.retryable).toBe(false);
    expect(toErrorEvent(f).retryable).toBe(false);
  });
});
