import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";
import { overviewFromLegacy } from "./kit-overview-test-helpers.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let activeRoot: Root | null = null;
beforeAll(() => setupDom());
afterAll(() => teardownDom());
afterEach(async () => {
  if (!activeRoot) return;
  const root = activeRoot;
  activeRoot = null;
  await act(async () => root.unmount());
});

async function renderPage(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = mount();
  activeRoot = createRoot(host);
  await act(async () => {
    activeRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(KitDeployPage, { apiConfig: { baseUrl: "http://localhost", token: "test" } }),
      ),
    );
  });
  await flush();
  return host;
}

async function click(element: Element | null): Promise<void> {
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

describe("KitDeployPage — Deployment Overview states", () => {
  test("a failed Overview read exposes Retry and recovers from the same endpoint", async () => {
    let calls = 0;
    let fail = true;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        calls++;
        return fail ? json({ error: "overview_unavailable" }, 500) : json(overviewFromLegacy());
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();
    expect(host.querySelector('[data-testid="kit-catalog-error"]')).not.toBeNull();

    fail = false;
    await click(host.querySelector('[data-testid="kit-catalog-retry"]'));
    expect(calls).toBeGreaterThan(1);
    expect(host.querySelector('[data-testid="kit-catalog-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-empty"]')).not.toBeNull();
  });

  test("the empty-state action focuses Source input", async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") return json(overviewFromLegacy());
      return json({});
    }) as typeof fetch;
    const host = await renderPage();
    await click(host.querySelector('[data-testid="kit-empty-add-source"]'));
    expect(document.activeElement).toBe(host.querySelector('[data-testid="add-source-input"]'));
  });
});
