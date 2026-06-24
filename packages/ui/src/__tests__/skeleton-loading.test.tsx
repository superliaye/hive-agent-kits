// Skeleton loading states: KitDeployPage shows a content-shaped catalog
// skeleton while the catalog query is pending (replaced by real sections / the
// empty state once it resolves), and BackendsSettings shows skeleton cards
// until the first readiness fetch settles — distinguishing the loading window
// from a genuinely empty result.
//
// The harness uses a DEFERRED fetch: each endpoint's response is held open
// until the test resolves it, so the pending render frame can be observed
// before the data arrives (the normal flush()-resolving stub would race past
// the loading window).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackendReadiness, Catalog, KitState, VerifyReport } from "../api.ts";
import { BackendsSettings } from "../components/BackendsSettings.tsx";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
      // Drain a macrotask too: react-query schedules some work off setTimeout.
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };
let activeRoot: Root | null = null;

beforeAll(() => setupDom());
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

const emptyCatalog: Catalog = { entries: [], presets: [], problems: [] };
const kitState: KitState = {
  sync: [
    {
      state: "up_to_date",
      sha: null,
      fetchedAt: null,
      sourceId: "src-1",
      origin: "https://github.com/superliaye/my-agent-kits",
    },
  ],
  ledger: {
    kitVersion: "test",
    agents: [],
    instructions: [],
    skills: [],
    agentDefs: [],
    plugins: [],
    bundles: [],
  },
};
const emptyVerify: VerifyReport = { entries: [] };

describe("KitDeployPage catalog skeleton", () => {
  test("skeleton present while catalog pending, gone after it resolves", async () => {
    // Hold the catalog fetch open; state/verify resolve immediately so only the
    // catalog query gates the skeleton.
    const catalog = deferred<Response>();
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return catalog.promise;
      if (path === "/api/kit/state") return json(kitState);
      if (path === "/api/kit/verify") return json(emptyVerify);
      return json({});
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(KitDeployPage, { apiConfig }),
        ),
      );
    });
    await flush();

    // Pending window: skeleton shown, no real catalog sections, no empty copy.
    expect(host.querySelector('[data-testid="kit-catalog-skeleton"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-empty"]')).toBeNull();
    const skel = host.querySelector('[data-testid="kit-catalog-skeleton"]');
    expect(skel?.getAttribute("role")).toBe("status");
    expect(skel?.getAttribute("aria-busy")).toBe("true");

    // Resolve the catalog (empty) → skeleton gone, empty state shown.
    await act(async () => {
      catalog.resolve(json(emptyCatalog));
    });
    await flush();
    expect(host.querySelector('[data-testid="kit-catalog-skeleton"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-empty"]')).not.toBeNull();

    qc.clear();
  });

  test("skeleton replaced by real kind-sections after a non-empty catalog resolves", async () => {
    const catalog = deferred<Response>();
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return catalog.promise;
      if (path === "/api/kit/state") return json(kitState);
      if (path === "/api/kit/verify") return json(emptyVerify);
      return json({});
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(KitDeployPage, { apiConfig }),
        ),
      );
    });
    await flush();
    expect(host.querySelector('[data-testid="kit-catalog-skeleton"]')).not.toBeNull();

    const populated: Catalog = {
      entries: [
        {
          kind: "skill",
          name: "alpha",
          group: "",
          description: "A skill",
          deployable: true,
        },
      ],
      presets: [],
      problems: [],
    };
    await act(async () => {
      catalog.resolve(json(populated));
    });
    await flush();
    expect(host.querySelector('[data-testid="kit-catalog-skeleton"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-kind-skill"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-empty"]')).toBeNull();

    qc.clear();
  });
});

describe("BackendsSettings skeleton vs empty", () => {
  function installDeferred(readiness: Deferred<Response>): void {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/backends/readiness") return readiness.promise;
      return json({});
    }) as typeof fetch;
  }

  async function renderBackends(): Promise<HTMLElement> {
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(createElement(BackendsSettings, { apiConfig }));
    });
    await flush();
    return host;
  }

  test("skeleton shown during pending window; empty copy NOT present while loading", async () => {
    const readiness = deferred<Response>();
    installDeferred(readiness);
    const host = await renderBackends();

    expect(host.querySelector('[data-testid="backends-skeleton"]')).not.toBeNull();
    expect(host.textContent).not.toContain("No CLI backends detected.");
    const skel = host.querySelector('[data-testid="backends-skeleton"]');
    expect(skel?.getAttribute("role")).toBe("status");
    expect(skel?.getAttribute("aria-busy")).toBe("true");

    // Settle the empty result → skeleton gone, empty copy now shown.
    await act(async () => {
      readiness.resolve(json([] as BackendReadiness[]));
    });
    await flush();
    expect(host.querySelector('[data-testid="backends-skeleton"]')).toBeNull();
    expect(host.textContent).toContain("No CLI backends detected.");
  });

  test("cards appear (not empty copy) after a non-empty readiness response", async () => {
    const readiness = deferred<Response>();
    installDeferred(readiness);
    const host = await renderBackends();
    expect(host.querySelector('[data-testid="backends-skeleton"]')).not.toBeNull();

    const claude: BackendReadiness = {
      backend: "claude-code",
      installed: true,
      version: "2.0.13",
      reason: "ok",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed" },
    };
    await act(async () => {
      readiness.resolve(json([claude]));
    });
    await flush();
    expect(host.querySelector('[data-testid="backends-skeleton"]')).toBeNull();
    expect(host.querySelector('[data-testid="backend-card-claude-code"]')).not.toBeNull();
    expect(host.textContent).not.toContain("No CLI backends detected.");
  });
});
