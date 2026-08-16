import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ThemeProvider } from "@hive/theming";
import { environmentManager } from "@tanstack/query-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../App.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };
let activeRoot: Root | null = null;

beforeAll(() => {
  setupDom();
  environmentManager.setIsServer(() => false);
});

afterAll(async () => {
  environmentManager.setIsServer(() => true);
  await teardownDom();
});

afterEach(async () => {
  window.__hive = undefined;
  if (!activeRoot) return;
  const root = activeRoot;
  activeRoot = null;
  await act(async () => root.unmount());
});

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("App connection authority", () => {
  test("keeps reauthentication visible on Settings and gates its mutations", async () => {
    const reauthentication = {
      kind: "external" as const,
      displayName: "Arca",
      status: "reauthentication_required" as const,
    };
    window.__hive = {
      connection: reauthentication,
      getConnection: () => reauthentication,
    };
    globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> =>
      new Response("unavailable", { status: 503 })) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = mount();
    activeRoot = createRoot(host);
    await act(async () => {
      activeRoot?.render(
        <ThemeProvider persistence={{ load: async () => null, save: async () => {} }}>
          <QueryClientProvider client={client}>
            <App apiConfig={apiConfig} />
          </QueryClientProvider>
        </ThemeProvider>,
      );
    });
    await flush();

    await act(async () => {
      host
        .querySelector('[data-testid="tab-settings"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(host.querySelector('[data-testid="kit-reauthentication-required"]')).not.toBeNull();
    expect((host.querySelector(".settings-connection-gate") as HTMLFieldSetElement).disabled).toBe(
      true,
    );

    const connected = { ...reauthentication, status: "connected" as const };
    await act(async () => {
      window.dispatchEvent(new CustomEvent("hive:connection-changed", { detail: connected }));
    });
    expect(host.querySelector('[data-testid="kit-reauthentication-required"]')).toBeNull();
    expect((host.querySelector(".settings-connection-gate") as HTMLFieldSetElement).disabled).toBe(
      false,
    );
  });
});
