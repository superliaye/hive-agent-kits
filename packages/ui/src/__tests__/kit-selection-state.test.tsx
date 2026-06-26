// #52 selection-state rendering: a capability in the current selection must render
// as selected AT REST — accent border/tint (.kit-row.selected) + filled check
// (.kit-row-check.checked) — so a scan separates included from excluded rows. The
// selection is seeded from the deployed Ledger on first load.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source, VerifyReport } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

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
const GIT_ID = "git-src";
const GIT_ORIGIN = "https://github.com/owner/repo";

function skillEntry(name: string): CapabilityEntry {
  return {
    kind: "skill",
    name,
    description: `the ${name} skill`,
    group: "",
    deployable: true,
    shadowed: false,
    sourceIds: [GIT_ID],
    contentSha: "a".repeat(64),
  };
}

// Two skills in the active catalog; only "alpha" is in the deployed Ledger, so the
// seeded selection contains alpha but not beta.
function catalog(): Catalog {
  return { entries: [skillEntry("alpha"), skillEntry("beta")], presets: [], problems: [] };
}

function kitState(): KitState {
  return {
    sync: [
      {
        state: "up_to_date",
        sha: "abc1234def",
        fetchedAt: 1,
        sourceId: GIT_ID,
        origin: GIT_ORIGIN,
      },
    ],
    ledger: {
      kitVersion: "1.0.0",
      agents: ["claude"],
      skills: [{ name: "alpha" }],
      agentDefs: [],
      instructions: [],
      plugins: [],
      bundles: [],
    },
  };
}

function installStubs(): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources" && method === "GET")
      return json([
        {
          id: GIT_ID,
          origin: GIT_ORIGIN,
          kind: "git",
          active: true,
          createdAt: 1,
        } satisfies Source,
      ]);
    if (path === "/api/kit/diff" && method === "POST") return json({ entries: [] });
    return json({});
  }) as typeof fetch;
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

async function render(): Promise<HTMLElement> {
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

describe("KitDeployPage — #52 selection-state rendering", () => {
  test("a seeded-selected capability renders as selected at rest (.selected row + .checked mark)", async () => {
    installStubs();
    const host = await render();

    const alpha = host.querySelector('[data-testid="kit-row-skill-alpha"]');
    expect(alpha).not.toBeNull();
    expect(alpha?.classList.contains("selected")).toBe(true);
    const alphaCheck = alpha?.querySelector(".kit-row-check");
    expect(alphaCheck?.classList.contains("checked")).toBe(true);
  });

  test("a capability not in the selection renders deselected (no .selected / .checked)", async () => {
    installStubs();
    const host = await render();

    const beta = host.querySelector('[data-testid="kit-row-skill-beta"]');
    expect(beta).not.toBeNull();
    expect(beta?.classList.contains("selected")).toBe(false);
    const betaCheck = beta?.querySelector(".kit-row-check");
    expect(betaCheck?.classList.contains("checked")).toBe(false);
  });
});
