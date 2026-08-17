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

function row(
  kind: "skill" | "plugin" | "bundle",
  reconciliation: OverviewRow["reconciliation"] = "pending_add",
): OverviewRow {
  const name = kind === "skill" ? "arca-smoke" : kind === "plugin" ? "arca-plugin" : "archify";
  const applicableTargets =
    kind === "plugin" ? (["claude"] as const) : (["claude", "codex"] as const);
  const desired =
    kind === "plugin" || reconciliation === "pending_remove" ? ("off" as const) : ("on" as const);
  return {
    key: { kind, name },
    catalog: "deployable",
    desired,
    reconciliation,
    lastAttempt: { state: "none" },
    applicableTargets: [...applicableTargets],
    targets: applicableTargets.map((target) => ({
      target,
      desired,
      reconciliation,
      observation:
        kind === "plugin"
          ? ("recorded_unverified" as const)
          : reconciliation === "pending_remove"
            ? ("verified" as const)
            : ("missing" as const),
      lastAttempt: { state: "none" as const },
    })),
    variants: [
      {
        kind,
        name,
        description: "Arca capability",
        group: "",
        deployable: true,
        shadowed: false,
        sourceIds: ["src"],
        contentSha: "a".repeat(64),
        catalog: "deployable",
      },
    ],
  };
}

function overview(over: Partial<DeploymentOverview> = {}): DeploymentOverview {
  const rows = over.rows ?? [row("skill")];
  return {
    sources: [{ id: "src", label: "Arca", kind: "git", active: true, rank: 0 }],
    sourceRegistryRevision: 1,
    mirrors: [{ sourceId: "src", precedence: 0, identity: "abc" }],
    selectionRevision: 8,
    variants: rows.flatMap((entry) => entry.variants),
    rows,
    diff: { entries: [{ kind: "skill", name: "arca-smoke", change: "added" }] },
    planToken: "8".repeat(64),
    activeOperation: null,
    lastOperation: null,
    ...over,
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

describe("KitDeployPage — reviewed deploy acceptance", () => {
  test("Deploy submits only the reviewed selection revision and plan token", async () => {
    const bodies: unknown[] = [];
    let accepted = false;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        return json(
          overview(
            accepted
              ? {
                  activeOperation: {
                    operationId: "op-8",
                    state: "running",
                    acceptedAt: 1,
                    selectionRevision: 8,
                    planToken: "8".repeat(64),
                  },
                }
              : {},
          ),
        );
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        accepted = true;
        return json({ operationId: "op-8" }, 202);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));

    expect(bodies).toEqual([{ selectionRevision: 8, planToken: "8".repeat(64) }]);
    expect(host.querySelector('[data-testid="kit-operation-status"]')?.textContent).toContain(
      "running",
    );
  });

  test("plan_stale disables Deploy until a newer Overview arrives", async () => {
    let overviewCalls = 0;
    const bodies: unknown[] = [];
    let releaseOverview: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview());
        if (overviewCalls > 2) {
          return json(
            overview({
              selectionRevision: 9,
              planToken: "9".repeat(64),
              lastOperation: {
                operationId: "op-9",
                state: "completed",
                acceptedAt: 1,
                completedAt: 2,
                selectionRevision: 9,
                planToken: "9".repeat(64),
              },
            }),
          );
        }
        return await new Promise<Response>((resolve) => {
          releaseOverview = resolve;
        });
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return bodies.length === 1
          ? json({ error: "plan_stale" }, 409)
          : json({ operationId: "op-9" }, 202);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(bodies).toHaveLength(1);
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).toContain(
      "Waiting for a newer Overview",
    );
    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).not.toContain(
      "refreshed",
    );

    await act(async () =>
      releaseOverview?.(json(overview({ selectionRevision: 9, planToken: "9".repeat(64) }))),
    );
    await flush();

    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(host.querySelector('[data-testid="kit-deploy-error"]')).toBeNull();

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(bodies).toEqual([
      { selectionRevision: 8, planToken: "8".repeat(64) },
      { selectionRevision: 9, planToken: "9".repeat(64) },
    ]);
  });

  test("a transport failure accepts a new lastOperation as authoritative evidence", async () => {
    let overviewCalls = 0;
    let releaseOverview: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        overviewCalls++;
        if (overviewCalls === 1) {
          return json(
            overview({
              lastOperation: {
                operationId: "op-before",
                state: "completed",
                acceptedAt: 1,
                completedAt: 2,
                selectionRevision: 7,
                planToken: "7".repeat(64),
              },
            }),
          );
        }
        return await new Promise<Response>((resolve) => {
          releaseOverview = resolve;
        });
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        return json({ error: "unavailable" }, 503);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));

    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).toContain(
      "acceptance is unknown",
    );
    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).not.toContain(
      "could not be accepted",
    );

    await act(async () =>
      releaseOverview?.(
        json(
          overview({
            lastOperation: {
              operationId: "op-after",
              state: "completed",
              acceptedAt: 3,
              completedAt: 4,
              selectionRevision: 8,
              planToken: "8".repeat(64),
            },
          }),
        ),
      ),
    );
    await flush();

    expect(host.querySelector('[data-testid="kit-deploy-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-operation-status"]')?.textContent).toContain(
      "completed · op-after",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("a transport failure accepts a new activeOperation as authoritative evidence", async () => {
    let overviewCalls = 0;
    let releaseOverview: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        overviewCalls++;
        if (overviewCalls === 1) {
          return json(
            overview({
              lastOperation: {
                operationId: "op-before",
                state: "completed",
                acceptedAt: 1,
                completedAt: 2,
                selectionRevision: 7,
                planToken: "7".repeat(64),
              },
            }),
          );
        }
        return await new Promise<Response>((resolve) => {
          releaseOverview = resolve;
        });
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        return json({ error: "unavailable" }, 503);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));

    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).toContain(
      "acceptance is unknown",
    );

    await act(async () =>
      releaseOverview?.(
        json(
          overview({
            activeOperation: {
              operationId: "op-active",
              state: "running",
              acceptedAt: 3,
              selectionRevision: 8,
              planToken: "8".repeat(64),
            },
            lastOperation: {
              operationId: "op-before",
              state: "completed",
              acceptedAt: 1,
              completedAt: 2,
              selectionRevision: 7,
              planToken: "7".repeat(64),
            },
          }),
        ),
      ),
    );
    await flush();

    expect(host.querySelector('[data-testid="kit-deploy-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-operation-status"]')?.textContent).toContain(
      "running · op-active",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a transport failure ignores an unrelated operation accepted from another reviewed plan", async () => {
    let overviewCalls = 0;
    let releaseOverview: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview());
        return await new Promise<Response>((resolve) => {
          releaseOverview = resolve;
        });
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        return json({ error: "unavailable" }, 503);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    await act(async () =>
      releaseOverview?.(
        json(
          overview({
            lastOperation: {
              operationId: "other-client-operation",
              state: "completed",
              acceptedAt: 3,
              completedAt: 4,
              selectionRevision: 99,
              planToken: "9".repeat(64),
            },
          }),
        ),
      ),
    );
    await flush();

    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).toContain(
      "could not be accepted",
    );
  });

  test("a failed ambiguity reload resolves after a later successful Overview retry", async () => {
    let overviewCalls = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        overviewCalls++;
        return overviewCalls === 2 ? json({ error: "unavailable" }, 503) : json(overview());
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        return json({ error: "unavailable" }, 503);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));

    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).toContain(
      "acceptance is unknown",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );

    await click(host.querySelector('[data-testid="kit-catalog-retry"]'));

    expect(host.querySelector('[data-testid="kit-deploy-error"]')?.textContent).toContain(
      "could not be accepted",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("a removal-bearing plan requires explicit confirmation", async () => {
    let deployCalls = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview")
        return json(
          overview({
            diff: { entries: [{ kind: "skill", name: "arca-smoke", change: "removed" }] },
          }),
        );
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        deployCalls++;
        return json({ operationId: "op-remove" }, 202);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(deployCalls).toBe(0);
    await click(host.querySelector('[data-testid="kit-deploy-confirm"]'));
    expect(deployCalls).toBe(1);
  });

  test("eligible bundle actions use the normal Deploy diff without manual banners", async () => {
    const archify = row("bundle", "pending_add");
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        return json(
          overview({
            rows: [archify],
            diff: { entries: [{ kind: "bundle", name: "archify", change: "added" }] },
          }),
        );
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-manual-install"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-manual-removal"]')).toBeNull();
    expect(host.textContent).toContain("archify");
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("eligible bundle removal uses destructive confirmation", async () => {
    const archify = row("bundle", "pending_remove");
    let deployCalls = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        return json(
          overview({
            rows: [archify],
            diff: { entries: [{ kind: "bundle", name: "archify", change: "removed" }] },
          }),
        );
      }
      if (path === "/api/kit/deploy" && init?.method === "POST") {
        deployCalls += 1;
        return json({ operationId: "remove-archify" }, 202);
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(deployCalls).toBe(0);
    await click(host.querySelector('[data-testid="kit-deploy-confirm"]'));
    expect(deployCalls).toBe(1);
  });

  test("unsupported bundle installers retain the manual banner", async () => {
    const legacy = row("bundle", "manual_install_required");
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        return json(overview({ rows: [legacy], diff: { entries: [] } }));
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-manual-install"]')?.textContent).toContain(
      "lack durable metadata",
    );
  });

  test("plugin deselection says manual removal required and never makes Deploy an uninstall action", async () => {
    const plugin = row("plugin", "manual_removal_required");
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview")
        return json(overview({ rows: [plugin], diff: { entries: [] } }));
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-manual-removal"]')?.textContent).toContain(
      "Manual removal required",
    );
    expect(host.querySelector('[data-testid="kit-manual-removal"]')?.textContent).toContain(
      "does not uninstall",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("plugin selection says manual install required and never blocks other Deploy actions", async () => {
    const plugin = row("plugin", "manual_install_required");
    const deployable = row("skill", "pending_add");
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
      if (path === "/api/kit/overview") {
        return json(
          overview({
            rows: [plugin, deployable],
            diff: { entries: [{ kind: "skill", name: "regular", change: "added" }] },
          }),
        );
      }
      return json({});
    }) as typeof fetch;
    const host = await renderPage();

    expect(host.querySelector('[data-testid="kit-manual-install"]')?.textContent).toContain(
      "Manual install required",
    );
    expect(host.querySelector('[data-testid="kit-manual-install"]')?.textContent).toContain(
      "does not run",
    );
    expect((host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
