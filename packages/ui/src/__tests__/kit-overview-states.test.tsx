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

function row(over: Partial<OverviewRow> & Pick<OverviewRow, "key">): OverviewRow {
  const applicableTargets = over.applicableTargets ?? ["claude", "codex"];
  return {
    catalog: "deployable",
    desired: "off",
    reconciliation: "in_sync",
    lastAttempt: { state: "none" },
    applicableTargets,
    targets: applicableTargets.map((target) => ({
      target,
      desired: "off",
      reconciliation: "in_sync",
      observation: "missing",
      lastAttempt: { state: "none" },
    })),
    variants: [],
    ...over,
  };
}

function overview(rows: OverviewRow[]): DeploymentOverview {
  return {
    sources: [{ id: "src", label: "Arca", kind: "git", active: true, rank: 0 }],
    sourceRegistryRevision: 3,
    mirrors: [{ sourceId: "src", precedence: 0, identity: "abc" }],
    selectionRevision: 7,
    variants: rows.flatMap((entry) => entry.variants),
    rows,
    diff: { entries: [] },
    planToken: "7".repeat(64),
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
  window.__hive = undefined;
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
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("KitDeployPage — daemon Overview states", () => {
  test("keeps selected unavailable and Ledger-only rows visible as separate facts", async () => {
    const current = overview([
      row({
        key: { kind: "instruction", name: "arca-smoke" },
        catalog: "unavailable",
        desired: "on",
        reconciliation: "waiting_for_source",
        targets: [
          {
            target: "claude",
            desired: "on",
            reconciliation: "waiting_for_source",
            observation: "missing",
            lastAttempt: { state: "none" },
          },
          {
            target: "codex",
            desired: "on",
            reconciliation: "waiting_for_source",
            observation: "missing",
            lastAttempt: { state: "none" },
          },
        ],
      }),
      row({
        key: { kind: "skill", name: "ledger-only" },
        catalog: "unavailable",
        reconciliation: "unmanaged_owned",
        applicableTargets: ["claude"],
        targets: [
          {
            target: "claude",
            desired: "off",
            reconciliation: "unmanaged_owned",
            observation: "present_unverified",
            lastAttempt: { state: "none" },
          },
        ],
      }),
    ]);
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      paths.push(path);
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.textContent).toContain("arca-smoke");
    expect(host.textContent).toContain("Waiting for source");
    expect(host.textContent).toContain("ledger-only");
    expect(host.textContent).toContain("Owned outside deployment state");
    expect(paths).not.toContain("/api/kit/catalog");
    expect(paths).not.toContain("/api/kit/state");
    expect(paths).not.toContain("/api/kit/verify");
    expect(paths).not.toContain("/api/kit/diff");
    expect(paths).not.toContain("/api/sources");
  });

  test("toggle PATCHes the Overview revision and exact applicable target set", async () => {
    const variant = {
      kind: "skill" as const,
      name: "arca-smoke",
      description: "Smoke test Arca",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: ["src"],
      contentSha: "a".repeat(64),
      catalog: "deployable" as const,
    };
    const current = overview([
      row({
        key: { kind: "skill", name: "arca-smoke" },
        applicableTargets: ["claude"],
        targets: [
          {
            target: "claude",
            desired: "off",
            reconciliation: "in_sync",
            observation: "missing",
            lastAttempt: { state: "none" },
          },
        ],
        variants: [variant],
      }),
    ]);
    const patches: unknown[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/selection" && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return json({ revision: 8, enabled: [], removalIntents: [] });
      }
      return json({});
    }) as typeof fetch;

    const host = await renderPage();
    await click(host.querySelector('[role="switch"][aria-label*="arca-smoke"]'));

    expect(patches).toEqual([
      {
        expectedRevision: 7,
        changes: [
          {
            key: { kind: "skill", name: "arca-smoke" },
            enabled: true,
            targets: ["claude"],
          },
        ],
      },
    ]);
  });

  test("shadowed variants remain visible and cannot mutate Selection", async () => {
    const loser = {
      kind: "skill" as const,
      name: "duplicate",
      description: "lower precedence",
      group: "",
      deployable: false,
      shadowed: true,
      sourceIds: ["src-low"],
      contentSha: "b".repeat(64),
      shadowedBy: "src",
      catalog: "shadowed" as const,
    };
    const current = overview([
      row({
        key: { kind: "skill", name: "duplicate" },
        catalog: "shadowed",
        variants: [loser],
      }),
    ]);
    let patchCount = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/selection" && init?.method === "PATCH") patchCount++;
      return json({});
    }) as typeof fetch;

    const host = await renderPage();
    const shadowed = host.querySelector('[data-testid="kit-row-skill-duplicate"]');
    expect(shadowed).not.toBeNull();
    expect(shadowed?.textContent).toContain("not deployed (duplicate)");
    expect((shadowed as HTMLButtonElement).disabled).toBe(true);
    await click(shadowed);
    expect(patchCount).toBe(0);
  });

  test("shows the Shell connection and refetches Overview on reconnect", async () => {
    window.__hive = {
      connection: { kind: "external", displayName: "Arca", status: "disconnected" },
    };
    let overviewCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") {
        overviewCalls++;
        return json(overview([]));
      }
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-connection"]')?.textContent).toContain(
      "Arca · disconnected",
    );
    const beforeReconnect = overviewCalls;
    await act(async () => window.dispatchEvent(new Event("online")));
    await flush();
    expect(overviewCalls).toBeGreaterThan(beforeReconnect);
  });
});
