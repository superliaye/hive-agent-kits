// Renderer→main deploy-in-flight bridge (Feature 3) — unit tests against a
// mockable window.__hive.setDeployInFlight, covering the Electron path and the
// browser-tab no-op.

import { afterEach, describe, expect, test } from "bun:test";
import { signalDeployInFlight } from "./deploy-in-flight.ts";

type Bridge = (inFlight: boolean) => Promise<void>;

function withBridge(bridge: Bridge | undefined): void {
  (globalThis as { window?: { __hive?: { setDeployInFlight?: Bridge } } }).window = bridge
    ? { __hive: { setDeployInFlight: bridge } }
    : {};
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = undefined;
});

describe("signalDeployInFlight", () => {
  test("forwards true to the preload bridge when a deploy starts", async () => {
    const calls: boolean[] = [];
    withBridge(async (v) => {
      calls.push(v);
    });
    await signalDeployInFlight(true);
    expect(calls).toEqual([true]);
  });

  test("forwards false to the bridge when the deploy settles", async () => {
    const calls: boolean[] = [];
    withBridge(async (v) => {
      calls.push(v);
    });
    await signalDeployInFlight(true);
    await signalDeployInFlight(false);
    expect(calls).toEqual([true, false]);
  });

  test("is a silent no-op in a plain browser tab (no __hive bridge)", async () => {
    withBridge(undefined);
    // Must resolve without throwing even though no bridge exists.
    await expect(signalDeployInFlight(true)).resolves.toBeUndefined();
  });
});
