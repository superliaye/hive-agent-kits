// Per-Source freshness header (#30): the Kit Deploy page renders one row per
// Source from KitState.sync (SourceSyncStatus[]). The first row keeps the stable
// `kit-sha`/`kit-freshness` testids; later rows carry per-Source testids. A
// failed/rate-limited Source shows a distinct error badge (never "Up to date"),
// independent of healthy siblings' rows.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Catalog, KitState, Source, VerifyReport } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

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

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };
const emptyCatalog: Catalog = { entries: [], presets: [], problems: [] };
const emptyVerify: VerifyReport = { entries: [] };

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

// Render the page with a given KitState (sync array drives the freshness header).
// The sources list is derived from the sync entries (same order, all active +
// synced), so the bare kit-sha/kit-freshness testids land on the first synced row.
async function renderWith(kitState: KitState): Promise<HTMLElement> {
  const sources: Source[] = kitState.sync.map((s, i) => ({
    id: s.sourceId,
    origin: s.origin,
    kind: "git",
    active: true,
    createdAt: i,
  }));
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/kit/catalog") return json(emptyCatalog);
    if (path === "/api/kit/state") return json(kitState);
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources") return json(sources);
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
  return host;
}

describe("KitDeployPage per-Source freshness header", () => {
  test("single Source: one row, stable kit-sha + kit-freshness testids, reads as today's badge", async () => {
    const host = await renderWith({
      sync: [
        {
          state: "up_to_date",
          sha: "f799d5fabc",
          fetchedAt: 1,
          sourceId: "src-1",
          origin: "https://github.com/superliaye/my-agent-kits",
        },
      ],
      ledger: null,
    });

    const rows = host.querySelectorAll(".kit-source-row");
    expect(rows.length).toBe(1);
    const sha = host.querySelector('[data-testid="kit-sha"]');
    const fresh = host.querySelector('[data-testid="kit-freshness"]');
    expect(sha?.textContent).toBe("f799d5f");
    expect(fresh?.textContent).toBe("Up to date");
    expect(fresh?.className).toContain("kit-fresh-ok");
  });

  test("a failed Source shows a distinct error badge (never 'Up to date'), independent of a healthy row", async () => {
    const host = await renderWith({
      sync: [
        {
          state: "up_to_date",
          sha: "aaaaaaa0000",
          fetchedAt: 1,
          sourceId: "src-ok",
          origin: "https://github.com/owner/healthy",
        },
        {
          state: "check_failed",
          sha: "bbbbbbb1111",
          fetchedAt: 1,
          sourceId: "src-bad",
          origin: "https://github.com/owner/offline",
          errorReason: "offline",
        },
      ],
      ledger: null,
    });

    // Two rows.
    expect(host.querySelectorAll(".kit-source-row").length).toBe(2);

    // First (healthy) row keeps the stable testids and reads "Up to date".
    const firstFresh = host.querySelector('[data-testid="kit-freshness"]');
    expect(firstFresh?.textContent).toBe("Up to date");
    expect(firstFresh?.className).toContain("kit-fresh-ok");

    // Second (failed) row carries its per-Source testid and a distinct error
    // badge — NEVER "Up to date".
    const badFresh = host.querySelector('[data-testid="kit-freshness-src-bad"]');
    expect(badFresh).not.toBeNull();
    expect(badFresh?.textContent).toBe("Check failed");
    expect(badFresh?.className).toContain("kit-fresh-error");
    expect(badFresh?.textContent).not.toBe("Up to date");
  });

  test("when GET /api/sources errors, the header falls back to read-only state.sync rows (no toggle, no blank)", async () => {
    // Sources query fails; the header must still render its rows from state.sync,
    // read-only (no toggle control) rather than blanking.
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/kit/catalog") return json(emptyCatalog);
      if (path === "/api/kit/state")
        return json({
          sync: [
            {
              state: "up_to_date",
              sha: "f799d5fabc",
              fetchedAt: 1,
              sourceId: "src-1",
              origin: "https://github.com/superliaye/my-agent-kits",
            },
          ],
          ledger: null,
        });
      if (path === "/api/kit/verify") return json(emptyVerify);
      if (path === "/api/sources")
        return new Response("boom", { status: 500, statusText: "Server Error" });
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

    // The source row still renders from state.sync...
    expect(host.querySelector('[data-testid="kit-source-src-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-sha"]')?.textContent).toBe("f799d5f");
    // ...but read-only: no toggle control while the sources list is unavailable.
    expect(host.querySelector('[data-testid="kit-source-toggle-src-1"]')).toBeNull();
  });

  test("a rate-limited Source shows the Rate-limited badge with an error class", async () => {
    const host = await renderWith({
      sync: [
        {
          state: "up_to_date",
          sha: "ccccccc2222",
          fetchedAt: 1,
          sourceId: "src-ok",
          origin: "https://github.com/owner/healthy",
        },
        {
          state: "rate_limited",
          sha: null,
          fetchedAt: null,
          sourceId: "src-rl",
          origin: "https://github.com/owner/limited",
          errorReason: "rate_limited",
          rateLimitReset: 1_700_000_000,
        },
      ],
      ledger: null,
    });

    const rlFresh = host.querySelector('[data-testid="kit-freshness-src-rl"]');
    expect(rlFresh?.textContent).toBe("Rate-limited");
    expect(rlFresh?.className).toContain("kit-fresh-error");
  });
});
