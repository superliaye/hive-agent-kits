import { afterEach, describe, expect, test } from "bun:test";
import { api, resolveApiConfig, type TileSummary } from "../api.ts";

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

  test("lists and adds Tiles through the bridge", async () => {
    const tile: TileSummary = {
      id: "archify",
      label: "Archify",
      description: "The archify skill.",
      url: "https://github.com/tt-a1i/archify",
      recipe: { id: "published-skills", label: "Published skills", unit: "pick" },
      sourceId: null,
    };
    const added = {
      source: { id: "s1", label: "Archify", kind: "git", active: true, createdAt: 1, rank: 1 },
      sync: { state: "up_to_date", sha: "abc", fetchedAt: 1, sourceId: "s1" },
      validation: { conformant: true, errors: [], capabilityCount: 1 },
    };
    const calls: Array<{ path: string; init: { method?: string; body?: string } }> = [];
    globalThis.window = {
      __hive: {
        daemon: {
          request: async (path: string, init: { method?: string; body?: string }) => {
            calls.push({ path, init });
            return init.method === "POST"
              ? { status: 201, statusText: "Created", body: JSON.stringify(added) }
              : { status: 200, statusText: "OK", body: JSON.stringify([tile]) };
          },
        },
      },
    } as Window & typeof globalThis;

    const config = resolveApiConfig();
    expect(await api.listTiles(config)).toEqual([tile]);
    expect((await api.addTile(config, "archify")).source.id).toBe("s1");
    expect(calls.map((call) => [call.path, call.init.method, call.init.body])).toEqual([
      ["/api/tiles", undefined, undefined],
      ["/api/sources", "POST", JSON.stringify({ tile: "archify" })],
    ]);
  });
});
