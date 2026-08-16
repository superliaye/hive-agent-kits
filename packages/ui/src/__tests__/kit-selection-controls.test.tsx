import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type {
  Catalog,
  DeploymentOverview,
  DeployTarget,
  OverviewRow,
  SelectionMutation,
  SelectionSnapshot,
} from "@hive/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };
const SOURCE_ID = "source";

const catalog: Catalog = {
  entries: ["alpha", "beta"].map((name) => ({
    kind: "skill" as const,
    name,
    description: `${name} skill`,
    group: "",
    deployable: true,
    shadowed: false,
    sourceIds: [SOURCE_ID],
    contentSha: (name === "alpha" ? "a" : "b").repeat(64),
  })),
  presets: [
    {
      name: "starter",
      description: "Starter capabilities",
      defaultAgents: ["claude"],
      capabilities: {
        instructions: [],
        skills: ["alpha"],
        agents: [],
        plugins: [],
        bundles: [],
      },
    },
  ],
  problems: [],
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(name: string, desiredTargets: DeployTarget[]): OverviewRow {
  const selected = desiredTargets.length > 0;
  return {
    key: { kind: "skill", name },
    catalog: "deployable",
    desired: selected ? "on" : "off",
    reconciliation: selected ? "in_sync" : "pending_add",
    lastAttempt: { state: "none" },
    applicableTargets: ["claude", "codex"],
    targets: (["claude", "codex"] as DeployTarget[]).map((target) => ({
      target,
      desired: desiredTargets.includes(target) ? "on" : "off",
      reconciliation: desiredTargets.includes(target) ? "in_sync" : "pending_add",
      observation: "missing",
      lastAttempt: { state: "none" },
    })),
    variants: [
      {
        kind: "skill",
        name,
        description: `${name} skill`,
        group: "",
        deployable: true,
        shadowed: false,
        sourceIds: [SOURCE_ID],
        contentSha: (name === "alpha" ? "a" : "b").repeat(64),
        catalog: "deployable",
      },
    ],
  };
}

function createApi(initial: Record<string, DeployTarget[]>): {
  fetch: typeof fetch;
  mutations: SelectionMutation[];
} {
  let revision = 7;
  const selected = new Map(
    Object.entries(initial).map(([name, targets]) => [name, new Set<DeployTarget>(targets)]),
  );
  const mutations: SelectionMutation[] = [];

  const overview = (): DeploymentOverview => {
    const rows = ["alpha", "beta"].map((name) => row(name, [...(selected.get(name) ?? [])]));
    return {
      sources: [{ id: SOURCE_ID, label: "Source", kind: "git", active: true, rank: 0 }],
      sourceRegistryRevision: 1,
      mirrors: [{ sourceId: SOURCE_ID, precedence: 0, identity: "abc123" }],
      selectionRevision: revision,
      variants: rows.flatMap((entry) => entry.variants),
      rows,
      diff: { entries: [] },
      planToken: revision.toString(16).repeat(64).slice(0, 64),
      activeOperation: null,
      lastOperation: null,
    };
  };

  const snapshot = (): SelectionSnapshot => ({
    revision,
    enabled: [...selected.entries()]
      .filter(([, targets]) => targets.size > 0)
      .map(([name, targets]) => ({
        key: { kind: "skill", name },
        targets: [...targets],
      })),
    removalIntents: [],
  });

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/kit/overview") return json(overview());
    if (path === "/api/kit/catalog") return json(catalog);
    if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
    if (path === "/api/kit/selection" && init?.method === "PATCH") {
      const mutation = JSON.parse(String(init.body)) as SelectionMutation;
      mutations.push(mutation);
      for (const change of mutation.changes) {
        const targets = selected.get(change.key.name) ?? new Set<DeployTarget>();
        for (const target of change.targets) {
          if (change.enabled) targets.add(target);
          else targets.delete(target);
        }
        selected.set(change.key.name, targets);
      }
      revision++;
      return json(snapshot());
    }
    return json({});
  }) as typeof fetch;

  return { fetch: fakeFetch, mutations };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) {
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

async function renderPage(fakeFetch: typeof fetch): Promise<HTMLElement> {
  globalThis.fetch = fakeFetch;
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
  await act(async () => (element as HTMLElement | null)?.click());
  await flush();
}

describe("KitDeployPage — Selection controls", () => {
  test("applying a Preset adds its capabilities and preserves manual Selection", async () => {
    const server = createApi({ beta: ["claude"] });
    const host = await renderPage(server.fetch);

    await click(host.querySelector(".kit-preset"));

    expect(server.mutations).toEqual([
      {
        expectedRevision: 7,
        changes: [
          {
            key: { kind: "skill", name: "alpha" },
            enabled: true,
            targets: ["claude"],
          },
        ],
      },
    ]);
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')?.className).toContain(
      "selected",
    );
    expect(host.querySelector('[data-testid="kit-row-skill-beta"]')?.className).toContain(
      "selected",
    );
    expect(host.querySelector(".kit-preset")?.className).toContain("active");
    expect(host.querySelector('[data-testid="kit-preset-note"]')?.textContent).toContain(
      "1 selected outside active Presets",
    );
  });

  test("removing an active Preset keeps capabilities selected outside that Preset", async () => {
    const server = createApi({ alpha: ["claude"], beta: ["claude"] });
    const host = await renderPage(server.fetch);

    await click(host.querySelector(".kit-preset"));

    expect(server.mutations).toEqual([
      {
        expectedRevision: 7,
        changes: [
          {
            key: { kind: "skill", name: "alpha" },
            enabled: false,
            targets: ["claude"],
          },
        ],
      },
    ]);
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')?.className).not.toContain(
      "selected",
    );
    expect(host.querySelector('[data-testid="kit-row-skill-beta"]')?.className).toContain(
      "selected",
    );
  });

  test("target controls default new selections to Claude and update selected targets", async () => {
    const server = createApi({});
    const host = await renderPage(server.fetch);
    const claude = host.querySelector('[data-testid="kit-target-claude"]') as HTMLInputElement;
    const codex = host.querySelector('[data-testid="kit-target-codex"]') as HTMLInputElement;

    expect(claude.checked).toBe(true);
    expect(codex.checked).toBe(false);

    await click(host.querySelector('[data-testid="kit-row-skill-beta"]'));
    expect(server.mutations[0]).toEqual({
      expectedRevision: 7,
      changes: [
        {
          key: { kind: "skill", name: "beta" },
          enabled: true,
          targets: ["claude"],
        },
      ],
    });

    await click(host.querySelector('[data-testid="kit-target-codex"]'));
    expect(server.mutations[1]).toEqual({
      expectedRevision: 8,
      changes: [
        {
          key: { kind: "skill", name: "beta" },
          enabled: true,
          targets: ["codex"],
        },
      ],
    });
    expect(
      (host.querySelector('[data-testid="kit-target-claude"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (host.querySelector('[data-testid="kit-target-codex"]') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
