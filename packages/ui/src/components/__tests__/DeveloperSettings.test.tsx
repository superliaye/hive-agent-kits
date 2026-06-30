// DeveloperSettings — prose-free surface (explanation behind the info icon),
// the compact armed indicator, and the optimistic toggle round-trip against a
// stubbed /api/developer.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mount, setupDom, teardownDom } from "../../__tests__/happy-dom-env.ts";
import type { ApiConfig } from "../../api.ts";
import { DeveloperSettings } from "../DeveloperSettings.tsx";

// DeveloperSettings reads/writes the ["developer"] query (via useDeveloperConfig),
// so it needs a QueryClient in context.
function withQuery(node: ReturnType<typeof createElement>): ReturnType<typeof createElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, node);
}

const apiConfig: ApiConfig = { baseUrl: "http://localhost", token: "test-token" };

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

let activeRoot: Root | null = null;
// Server-side value the stubbed PUT persists; GET reads it back.
let stored = { allowRealHomeDeploy: false };

beforeAll(() => {
  setupDom();
});
afterAll(() => teardownDom());
afterEach(async () => {
  if (activeRoot) {
    const r = activeRoot;
    await act(async () => {
      r.unmount();
    });
    activeRoot = null;
  }
});

function stubFetch(): void {
  stored = { allowRealHomeDeploy: false };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/developer")) {
      if (init?.method === "PUT") {
        stored = JSON.parse(String(init.body)) as typeof stored;
        return json(stored);
      }
      return json(stored);
    }
    return json({});
  }) as typeof fetch;
}

// GET succeeds (off), but the PUT fails — exercises revert-on-failure + save error.
function stubFetchPutFails(): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/developer")) {
      if (init?.method === "PUT") {
        return new Response("nope", { status: 500 });
      }
      return json({ allowRealHomeDeploy: false });
    }
    return json({});
  }) as typeof fetch;
}

// GET never resolves — the toggle should stay disabled until config loads.
function stubFetchPending(): void {
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => new Promise<Response>(() => {})) as typeof fetch;
}

describe("DeveloperSettings", () => {
  test("renders the toggle off by default with no armed banner", async () => {
    stubFetch();
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(withQuery(createElement(DeveloperSettings, { apiConfig })));
    });
    await flush();

    const toggle = host.querySelector<HTMLInputElement>(
      '[data-testid="developer-allow-real-home-deploy"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.checked).toBe(false);
    // The armed indicator is absent while off.
    expect(host.querySelector('[data-testid="developer-real-home-armed"]')).toBeNull();
  });

  test("is prose-free: explanation lives behind the info icon, not a standalone paragraph", async () => {
    stubFetch();
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(withQuery(createElement(DeveloperSettings, { apiConfig })));
    });
    await flush();

    // The surface carries no standalone explanatory `.meta` paragraph; the
    // explanation lives behind the info icon.
    expect(host.querySelector("p.meta")).toBeNull();

    // The info trigger is present and accessible…
    const trigger = host.querySelector<HTMLButtonElement>(".setting-info-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("About Deploy to real home directory");

    // …and the consequence explanation is reachable behind it (in the DOM,
    // hidden at rest), not always-visible prose.
    const tip = host.querySelector<HTMLElement>('[data-testid="setting-info-tip"]');
    expect(tip).not.toBeNull();
    expect(tip?.hidden).toBe(true);
    expect(tip?.textContent ?? "").toContain("per-instance sandbox");
  });

  test("toggling on shows the compact armed indicator and persists via PUT", async () => {
    stubFetch();
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(withQuery(createElement(DeveloperSettings, { apiConfig })));
    });
    await flush();

    const toggle = host.querySelector<HTMLInputElement>(
      '[data-testid="developer-allow-real-home-deploy"]',
    );
    if (!toggle) throw new Error("toggle not found");

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Armed indicator now visible; the PUT persisted true server-side.
    expect(host.querySelector('[data-testid="developer-real-home-armed"]')).not.toBeNull();
    expect(stored.allowRealHomeDeploy).toBe(true);
  });

  test("reverts the toggle and surfaces a save error when the PUT fails", async () => {
    stubFetchPutFails();
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(withQuery(createElement(DeveloperSettings, { apiConfig })));
    });
    await flush();

    const toggle = host.querySelector<HTMLInputElement>(
      '[data-testid="developer-allow-real-home-deploy"]',
    );
    if (!toggle) throw new Error("toggle not found");

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Optimistic on reverted to off; armed indicator gone; save error shown.
    expect(toggle.checked).toBe(false);
    expect(host.querySelector('[data-testid="developer-real-home-armed"]')).toBeNull();
    expect(host.querySelector('[data-testid="developer-save-error"]')).not.toBeNull();
  });

  test("the toggle is disabled until the config loads", async () => {
    stubFetchPending();
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(withQuery(createElement(DeveloperSettings, { apiConfig })));
    });
    await flush();

    const toggle = host.querySelector<HTMLInputElement>(
      '[data-testid="developer-allow-real-home-deploy"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(true);
  });
});
