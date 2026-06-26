// Capabilities tab states (#48): the catalog body distinguishes loading / error /
// empty(first-run) from a populated catalog, and the PRESET/TARGETS bar only
// renders once the catalog has entries (never stranded over an empty/loading/error
// body).
//
//  (a) loading      → the content-shaped skeleton (kit-catalog-skeleton) fills the body.
//  (b) error        → a kit-catalog-error state with a kit-catalog-retry button that
//                     re-issues GET /api/kit/catalog (here: succeeding on the retry).
//  (c) empty/first-run → the deploy-manager explanation + a primary kit-empty-add-source
//                     CTA whose click focuses the header add-source-input.
//  (d) controls gate → kit-presets / kit-targets are ABSENT when the catalog is
//                     empty or errored, PRESENT once it has entries.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source, VerifyReport } from "../api.ts";
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
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };
const emptyVerify: VerifyReport = { entries: [] };
const emptyCatalog: Catalog = { entries: [], presets: [], problems: [] };

const GIT_ID = "git-src";
const GIT_ORIGIN = "https://github.com/owner/repo";

function sources(active: boolean): Source[] {
  return [{ id: GIT_ID, origin: GIT_ORIGIN, kind: "git", active, createdAt: 1 }];
}

function kitState(): KitState {
  return {
    sync: [
      {
        state: "up_to_date" as const,
        sha: "abc1234def",
        fetchedAt: 1,
        sourceId: GIT_ID,
        origin: GIT_ORIGIN,
      },
    ],
    ledger: null,
  };
}

function populatedCatalog(): Catalog {
  const entries: CapabilityEntry[] = [
    {
      kind: "skill",
      name: "alpha",
      description: "a git capability",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: [GIT_ID],
      contentSha: "a".repeat(64),
    },
  ];
  return { entries, presets: [], problems: [] };
}

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

async function renderPage(): Promise<HTMLElement> {
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
  return host;
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("KitDeployPage — catalog states (#48)", () => {
  test("(a) loading: the catalog skeleton fills the body, no empty/error/controls", async () => {
    // Hold the catalog fetch open so the pending render frame is observable; the
    // other queries resolve immediately so only the catalog gates the body.
    const catalog = deferred<Response>();
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return catalog.promise;
      if (path === "/api/kit/state") return json(kitState());
      if (path === "/api/kit/verify") return json(emptyVerify);
      if (path === "/api/sources") return json(sources(true));
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-catalog-skeleton"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-catalog-error"]')).toBeNull();
    // The PRESET/TARGETS bar must not strand over a loading body.
    expect(host.querySelector('[data-testid="kit-presets"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-targets"]')).toBeNull();

    // Resolve (populated) → skeleton gone, controls + sections appear.
    await act(async () => {
      catalog.resolve(json(populatedCatalog()));
    });
    await flush();
    expect(host.querySelector('[data-testid="kit-catalog-skeleton"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-presets"]')).not.toBeNull();
  });

  test("(b) error: kit-catalog-error shows; Retry re-issues GET /api/kit/catalog and recovers", async () => {
    let catalogCalls = 0;
    let failCatalog = true;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") {
        catalogCalls++;
        if (failCatalog) return new Response("nope", { status: 500, statusText: "Server Error" });
        return json(populatedCatalog());
      }
      if (path === "/api/kit/state") return json(kitState());
      if (path === "/api/kit/verify") return json(emptyVerify);
      if (path === "/api/sources") return json(sources(true));
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    // Error state present, no stray banner (the old thin .banner-error is gone), and
    // the controls bar does not strand over the errored body.
    const err = host.querySelector('[data-testid="kit-catalog-error"]');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain("Couldn't load the catalog");
    expect(host.querySelector('[data-testid="kit-presets"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-targets"]')).toBeNull();

    // A first Retry that STILL fails re-issues the GET but keeps the error state
    // (and a clickable Retry) — the error must not clear on a failed retry.
    const callsAfterMount = catalogCalls;
    await click(host.querySelector('[data-testid="kit-catalog-retry"]'));
    expect(catalogCalls).toBeGreaterThan(callsAfterMount);
    expect(host.querySelector('[data-testid="kit-catalog-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-catalog-retry"]')).not.toBeNull();

    const callsBefore = catalogCalls;
    // Now make the retry succeed → a fresh GET fires and the catalog renders.
    failCatalog = false;
    await click(host.querySelector('[data-testid="kit-catalog-retry"]'));

    expect(catalogCalls).toBeGreaterThan(callsBefore);
    expect(host.querySelector('[data-testid="kit-catalog-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-kind-skill"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-presets"]')).not.toBeNull();
  });

  test("(c) empty/first-run: explanation + Add-a-Source CTA whose click focuses add-source-input", async () => {
    // Empty catalog with an ACTIVE source → the first-run state, not all-disabled.
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return json(emptyCatalog);
      if (path === "/api/kit/state") return json(kitState());
      if (path === "/api/kit/verify") return json(emptyVerify);
      if (path === "/api/sources") return json(sources(true));
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    const empty = host.querySelector('[data-testid="kit-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("Hive deploys capabilities from one or more Git Sources");
    // All-disabled copy must NOT appear (a source is active).
    expect(host.querySelector('[data-testid="kit-empty-disabled"]')).toBeNull();

    const cta = host.querySelector('[data-testid="kit-empty-add-source"]');
    expect(cta).not.toBeNull();

    // Clicking the CTA focuses the header add-source input (ref, not DOM query).
    await click(cta);
    const input = host.querySelector('[data-testid="add-source-input"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  test("(d) controls gate: kit-presets/kit-targets present with entries, absent when empty", async () => {
    // Populated → controls present.
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return json(populatedCatalog());
      if (path === "/api/kit/state") return json(kitState());
      if (path === "/api/kit/verify") return json(emptyVerify);
      if (path === "/api/sources") return json(sources(true));
      return json({});
    }) as typeof fetch;
    let host = await renderPage();
    expect(host.querySelector('[data-testid="kit-presets"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-targets"]')).not.toBeNull();
    // Tear down before the empty render so document.activeElement etc. are clean.
    if (activeRoot) {
      const r = activeRoot;
      await act(async () => {
        r.unmount();
      });
      activeRoot = null;
    }

    // Empty → controls absent.
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return json(emptyCatalog);
      if (path === "/api/kit/state") return json(kitState());
      if (path === "/api/kit/verify") return json(emptyVerify);
      if (path === "/api/sources") return json(sources(true));
      return json({});
    }) as typeof fetch;
    host = await renderPage();
    expect(host.querySelector('[data-testid="kit-presets"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-targets"]')).toBeNull();
  });
});
