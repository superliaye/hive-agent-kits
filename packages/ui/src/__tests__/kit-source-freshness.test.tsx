import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";
import { overviewFromLegacy } from "./kit-overview-test-helpers.ts";

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

async function render(unavailable = false): Promise<HTMLElement> {
  const origin = "https://github.com/owner/arca";
  const source = {
    id: "src",
    label: "owner/arca",
    locator: {
      kind: "git" as const,
      repoUrl: origin,
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    },
    origin,
    kind: "git" as const,
    active: true,
    createdAt: 1,
    rank: 0,
  };
  const state = {
    sync: [
      {
        state: unavailable ? ("check_failed" as const) : ("up_to_date" as const),
        sha: "f799d5fabc",
        fetchedAt: 1,
        sourceId: "src",
        origin,
      },
    ],
    ledger: null,
  };
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw).pathname;
    if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
    if (path === "/api/kit/overview") return json(overviewFromLegacy({ sources: [source], state }));
    return json({});
  }) as typeof fetch;
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

describe("KitDeployPage — Source observations from Overview", () => {
  test("renders the Source label and mirror identity", async () => {
    const host = await render();
    expect(host.querySelector('[data-testid="kit-source-src"]')?.textContent).toContain(
      "owner/arca",
    );
    expect(host.querySelector('[data-testid="kit-sha-src"]')?.textContent).toBe("f799d5f");
    expect(host.querySelector('[data-testid="kit-freshness-src"]')?.textContent).toBe("Ready");
  });

  test("renders an unavailable mirror as an error fact", async () => {
    const host = await render(true);
    const status = host.querySelector('[data-testid="kit-freshness-src"]');
    expect(status?.textContent).toBe("Unavailable");
    expect(status?.className).toContain("kit-fresh-error");
  });
});
