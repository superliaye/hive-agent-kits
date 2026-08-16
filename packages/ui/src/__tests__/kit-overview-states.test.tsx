import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { DeploymentOverview, OverviewRow } from "@hive/contract";
import { environmentManager } from "@tanstack/query-core";
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
let activeClient: QueryClient | null = null;

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
  activeClient = null;
  await act(async () => root.unmount());
});

async function renderPage(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  activeClient = client;
  const host = mount();
  activeRoot = createRoot(host);
  const connection = window.__hive?.getConnection?.() ?? window.__hive?.connection;
  await act(async () => {
    activeRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(KitDeployPage, { apiConfig, connection }),
      ),
    );
  });
  await flush();
  return host;
}

async function rerenderPage(
  connection: NonNullable<Window["__hive"]>["connection"],
): Promise<void> {
  const root = activeRoot;
  const client = activeClient;
  if (!root || !client) throw new Error("page is not mounted");
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(KitDeployPage, { apiConfig, connection }),
      ),
    );
  });
  await flush();
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
    expect(host.querySelector('[data-testid="kit-instruction-blocked"]')?.textContent).toContain(
      "Whole-file instruction reconciliation is blocked",
    );
    expect(host.textContent).toContain("ledger-only");
    expect(host.textContent).toContain("Owned outside deployment state");
    expect(paths).not.toContain("/api/kit/catalog");
    expect(paths).not.toContain("/api/kit/state");
    expect(paths).not.toContain("/api/kit/verify");
    expect(paths).not.toContain("/api/kit/diff");
    expect(paths).not.toContain("/api/sources");
  });

  test("blocks whole-file reconciliation for an isolated orphaned instruction", async () => {
    const current = overview([
      row({
        key: { kind: "instruction", name: "orphaned-instructions" },
        catalog: "unavailable",
        desired: "on",
        reconciliation: "orphaned",
        targets: [
          {
            target: "claude",
            desired: "on",
            reconciliation: "orphaned",
            observation: "present_unverified",
            lastAttempt: { state: "none" },
          },
          {
            target: "codex",
            desired: "on",
            reconciliation: "orphaned",
            observation: "present_unverified",
            lastAttempt: { state: "none" },
          },
        ],
      }),
    ]);
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-instruction-blocked"]')?.textContent).toContain(
      "Whole-file instruction reconciliation is blocked",
    );
    expect(host.textContent).toContain("Source unavailable");
  });

  test("shows unmanaged instruction ownership without blocking an unrelated skill Deploy", async () => {
    const current = {
      ...overview([
        row({
          key: { kind: "instruction", name: "agent-kit-rules" },
          catalog: "unavailable",
          reconciliation: "unmanaged_owned",
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
        row({
          key: { kind: "skill", name: "ready-skill" },
          desired: "on",
          reconciliation: "pending_add",
          targets: [
            {
              target: "claude",
              desired: "on",
              reconciliation: "pending_add",
              observation: "missing",
              lastAttempt: { state: "none" },
            },
          ],
        }),
      ]),
      diff: {
        entries: [{ kind: "skill" as const, name: "ready-skill", change: "added" as const }],
      },
    };
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-instruction-unmanaged"]')?.textContent).toContain(
      "agent-kit-rules",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("reconstructs an initially active operation on cold mount", async () => {
    const current = {
      ...overview([]),
      diff: { entries: [{ kind: "skill" as const, name: "arca-smoke", change: "added" as const }] },
      activeOperation: {
        operationId: "op-active",
        state: "running" as const,
        acceptedAt: 1,
        selectionRevision: 7,
        planToken: "7".repeat(64),
      },
    };
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-operation-status"]')?.textContent).toContain(
      "running · op-active",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("reconstructs the last operation on cold mount", async () => {
    const current = {
      ...overview([]),
      lastOperation: {
        operationId: "op-last",
        state: "failed" as const,
        acceptedAt: 1,
        completedAt: 2,
        selectionRevision: 7,
        planToken: "7".repeat(64),
      },
    };
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-operation-status"]')?.textContent).toContain(
      "failed · op-last",
    );
  });

  test("renders verified observation independently from a failed last attempt", async () => {
    const failedAttempt = {
      state: "failed" as const,
      operationId: "op-failed",
      attemptedAt: 2,
      code: "write_failed",
    };
    const current = overview([
      row({
        key: { kind: "skill", name: "verified-after-failure" },
        desired: "on",
        lastAttempt: failedAttempt,
        targets: [
          {
            target: "claude",
            desired: "on",
            reconciliation: "in_sync",
            observation: "verified",
            lastAttempt: failedAttempt,
          },
          {
            target: "codex",
            desired: "on",
            reconciliation: "in_sync",
            observation: "verified",
            lastAttempt: failedAttempt,
          },
        ],
      }),
    ]);
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();
    const state = host.querySelector('[data-testid="kit-state-skill-verified-after-failure"]');

    expect(state?.textContent).toContain("Verified");
    expect(state?.textContent).toContain("Failed · write_failed");
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

  test("shows the disconnected Shell connection", async () => {
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
    expect(overviewCalls).toBe(1);
  });

  test("reads the mutable Shell snapshot when the exposed bridge value is frozen", async () => {
    window.__hive = {
      connection: { kind: "external", displayName: "Arca", status: "connected" },
      getConnection: () => ({
        kind: "external",
        displayName: "Arca",
        status: "disconnected",
      }),
    };
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(overview([]));
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;

    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-connection"]')?.textContent).toContain(
      "Arca · disconnected",
    );
    expect(
      (host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  test("does not aggressively poll an idle healthy Overview", async () => {
    window.__hive = {
      connection: { kind: "managed", displayName: "Local", status: "connected" },
    };
    let overviewCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") {
        overviewCalls += 1;
        return json(overview([]));
      }
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;
    await renderPage();
    const afterInitialLoad = overviewCalls;

    await act(async () => new Promise((resolve) => setTimeout(resolve, 2_050)));
    await flush();

    expect(overviewCalls).toBe(afterInitialLoad);
  });

  test("uses Shell state transitions to gate stale actions", async () => {
    window.__hive = {
      connection: { kind: "external", displayName: "Remote", status: "connected" },
    };
    const selected = row({
      key: { kind: "skill", name: "remote-skill" },
      desired: "on",
      reconciliation: "pending_add",
      targets: [
        {
          target: "claude",
          desired: "on",
          reconciliation: "pending_add",
          observation: "missing",
          lastAttempt: { state: "none" },
        },
        {
          target: "codex",
          desired: "on",
          reconciliation: "pending_add",
          observation: "missing",
          lastAttempt: { state: "none" },
        },
      ],
    });
    const current = {
      ...overview([selected]),
      sources: [
        { id: "src", label: "Arca", kind: "git" as const, active: true, rank: 1 },
        { id: "backup", label: "Backup", kind: "git" as const, active: true, rank: 0 },
      ],
      diff: {
        entries: [{ kind: "skill" as const, name: "remote-skill", change: "added" as const }],
      },
    };
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/kit/overview") return json(current);
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      return json({});
    }) as typeof fetch;
    const host = await renderPage();
    const deploy = host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement;
    const toggle = host.querySelector(
      '[data-testid="kit-row-skill-remote-skill"]',
    ) as HTMLButtonElement;
    const sourceToggle = host.querySelector(
      '[data-testid="kit-source-toggle-src"]',
    ) as HTMLInputElement;
    const sourceRemove = host.querySelector(
      '[data-testid="kit-source-delete-src"]',
    ) as HTMLButtonElement;
    const sourceReorder = host.querySelector(
      '[data-testid="kit-source-down-src"]',
    ) as HTMLButtonElement;
    const addSource = host.querySelector('[data-testid="add-source-input"]') as HTMLInputElement;
    expect(deploy.disabled).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(sourceToggle.disabled).toBe(false);
    expect(sourceRemove.disabled).toBe(false);
    expect(sourceReorder.disabled).toBe(false);
    expect(addSource.disabled).toBe(false);

    await rerenderPage({ kind: "external", displayName: "Remote", status: "disconnected" });
    expect(host.querySelector('[data-testid="kit-connection"]')?.textContent).toContain(
      "Remote · disconnected",
    );
    expect(deploy.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(sourceToggle.disabled).toBe(true);
    expect(sourceRemove.disabled).toBe(true);
    expect(sourceReorder.disabled).toBe(true);
    expect(addSource.disabled).toBe(true);

    await rerenderPage({ kind: "external", displayName: "Remote", status: "connected" });
    expect(host.querySelector('[data-testid="kit-connection"]')?.textContent).toContain(
      "Remote · connected",
    );
    expect(sourceToggle.disabled).toBe(false);
    expect(sourceRemove.disabled).toBe(false);
    expect(sourceReorder.disabled).toBe(false);
    expect(addSource.disabled).toBe(false);
  });
});
