import { afterEach, describe, expect, test } from "bun:test";
import { api, resolveApiConfig } from "../api.ts";

const priorWindow = globalThis.window;

afterEach(() => {
  if (priorWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else globalThis.window = priorWindow;
});

describe("Electron daemon bridge", () => {
  test("uses the privileged request function without renderer credentials", async () => {
    const calls: Array<{ path: string; init: unknown }> = [];
    const bridge = {
      connection: { kind: "external" as const, displayName: "Arca", status: "connected" as const },
      daemon: {
        request: async (path: string, init: unknown) => {
          calls.push({ path, init });
          return {
            status: 200,
            statusText: "OK",
            body: JSON.stringify({ sync: [], ledger: null }),
          };
        },
      },
    };
    globalThis.window = { __hive: bridge } as Window & typeof globalThis;

    const config = resolveApiConfig();
    expect(await api.getKitState(config)).toEqual({ sync: [], ledger: null });
    expect(calls).toEqual([
      { path: "/api/kit/state", init: { method: undefined, headers: {}, body: undefined } },
    ]);
    expect(window.__hive).not.toHaveProperty("token");
    expect(window.__hive).not.toHaveProperty("baseUrl");
  });
});
