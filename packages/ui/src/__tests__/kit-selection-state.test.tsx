import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { DeploymentOverview, OverviewRow } from "@hive/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function skill(name: string, desired: "on" | "off"): OverviewRow {
  return {
    key: { kind: "skill", name },
    catalog: "deployable",
    desired,
    reconciliation: desired === "on" ? "in_sync" : "pending_remove",
    lastAttempt: { state: "none" },
    applicableTargets: ["claude", "codex"],
    targets: ["claude", "codex"].map((target) => ({
      target: target as "claude" | "codex",
      desired,
      reconciliation: desired === "on" ? ("in_sync" as const) : ("pending_remove" as const),
      observation: desired === "on" ? ("verified" as const) : ("present_unverified" as const),
      lastAttempt: { state: "none" as const },
    })),
    variants: [
      {
        kind: "skill",
        name,
        description: `${name} skill`,
        group: "",
        deployable: true,
        shadowed: false,
        sourceIds: ["src"],
        contentSha: name === "alpha" ? "a".repeat(64) : "b".repeat(64),
        catalog: "deployable",
      },
    ],
  };
}

function overview(revision = 7): DeploymentOverview {
  const rows = [skill("alpha", "on"), skill("beta", "off")];
  return {
    sources: [{ id: "src", label: "Arca", kind: "git", active: true, rank: 0 }],
    sourceRegistryRevision: 1,
    mirrors: [{ sourceId: "src", precedence: 0, identity: "abc" }],
    selectionRevision: revision,
    variants: rows.flatMap((row) => row.variants),
    rows,
    diff: { entries: [{ kind: "skill", name: "beta", change: "removed" }] },
    planToken: String(revision).repeat(64).slice(0, 64),
    activeOperation: null,
    lastOperation: null,
  };
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
      createElement(QueryClientProvider, { client }, createElement(KitDeployPage, { apiConfig })),
    );
  });
  await flush();
  return host;
}

async function click(element: Element | null): Promise<void> {
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

describe("KitDeployPage — revisioned Selection", () => {
  test("renders the Daemon's desired state at rest", async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(overview());
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    expect(
      host.querySelector('[data-testid="kit-row-skill-alpha"]')?.classList.contains("selected"),
    ).toBe(true);
    expect(
      host.querySelector('[data-testid="kit-row-skill-beta"]')?.classList.contains("selected"),
    ).toBe(false);
  });

  test("a selection_conflict refetches Overview once and never retries stale intent", async () => {
    let overviewCalls = 0;
    let patchCalls = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") {
        overviewCalls++;
        return json(overview(overviewCalls === 1 ? 7 : 8));
      }
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/selection" && init?.method === "PATCH") {
        patchCalls++;
        return json({ error: "selection_conflict", currentRevision: 8 }, 409);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-row-skill-beta"]'));

    expect(patchCalls).toBe(1);
    expect(overviewCalls).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-testid="kit-selection-error"]')?.textContent).toContain(
      "refreshed",
    );
  });
});
