// #47 data-loss guard (UI): removal-bearing Deploys are gated behind an explicit
// two-step confirm, while no-op Deploy Diffs disable the primary action.
//
// The server is authoritative for the diff (#47 fixes computeDiff/reconcilePrune);
// these tests stub the diff endpoint to drive readiness and removal states.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SelectionSchema } from "@hive/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CapabilityEntry,
  Catalog,
  DeployTarget,
  KitState,
  Selection,
  Source,
  VerifyReport,
} from "../api.ts";
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

type Call = { method: string; path: string; body?: string };
let calls: Call[];
let removedSkill: string | null;
let ledgerSkills: string[];
let ledgerTargets: DeployTarget[];
let activeSkill: string | null;
let deferDiff: boolean;
let diffGate: (() => void) | null;

async function releaseDiff(): Promise<void> {
  await act(async () => {
    diffGate?.();
    diffGate = null;
  });
  await flush();
}

function sources(): Source[] {
  return [{ id: GIT_ID, origin: GIT_ORIGIN, kind: "git", active: true, createdAt: 1, rank: 0 }];
}

function catalog(): Catalog {
  const entries: CapabilityEntry[] =
    activeSkill === null
      ? []
      : [
          {
            kind: "skill",
            name: activeSkill,
            description: "an active capability",
            group: "",
            deployable: true,
            shadowed: false,
            sourceIds: [GIT_ID],
            contentSha: "a".repeat(64),
          },
        ];
  return { entries, presets: [], problems: [] };
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
      agents: ledgerTargets,
      skills: ledgerSkills.map((name) => ({ name })),
      agentDefs: [],
      instructions: [],
      plugins: [],
      bundles: [],
    },
  };
}

function installStubs(): void {
  calls = [];
  removedSkill = null;
  ledgerSkills = [];
  ledgerTargets = ["claude"];
  activeSkill = null;
  deferDiff = false;
  diffGate = null;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path, body });

    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources" && method === "GET") return json(sources());
    if (path === "/api/kit/sync" && method === "POST") return json({ sources: [] });
    if (path === "/api/kit/diff" && method === "POST") {
      const selection = parseSelection(body);
      const entries =
        removedSkill !== null && !selection.add.skills.includes(removedSkill)
          ? [{ kind: "skill", name: removedSkill, change: "removed", replacesUserFile: false }]
          : [];
      if (deferDiff) {
        return await new Promise<Response>((resolve) => {
          diffGate = () => resolve(json({ entries }));
        });
      }
      return json({ entries });
    }
    if (path === "/api/kit/deploy" && method === "POST") {
      return json({ kitSha: null, perKind: [], pruned: [], targets: ["claude"] });
    }
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

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function deployPosts(): number {
  return calls.filter((c) => c.method === "POST" && c.path === "/api/kit/deploy").length;
}

function diffCalls(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.path === "/api/kit/diff");
}

function parseSelection(body: string | undefined): Selection {
  if (body === undefined) throw new Error("missing selection request body");
  return SelectionSchema.parse(JSON.parse(body));
}

describe("KitDeployPage - Deploy readiness and removal confirm gate", () => {
  test("empty Selection can still be removal-bearing: first click arms confirm, confirm POSTs", async () => {
    installStubs();
    ledgerSkills = ["alpha"];
    activeSkill = "alpha";
    removedSkill = "alpha";
    const host = await render();

    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));

    const warn = host.querySelector('[data-testid="kit-deploy-remove-warn"]');
    expect(warn).not.toBeNull();
    expect(warn?.textContent ?? "").toContain("DELETE");
    expect(warn?.textContent ?? "").toContain("1");

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(deployPosts()).toBe(0);

    const confirm = host.querySelector('[data-testid="kit-deploy-confirm"]');
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent ?? "").toContain("Confirm");

    await click(confirm);
    expect(deployPosts()).toBe(1);
  });

  test("a settled empty diff disables Deploy, labels it Up to date, and does not POST", async () => {
    installStubs();
    activeSkill = "alpha";
    removedSkill = null;
    const host = await render();

    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));

    const deploy = host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement | null;
    expect(deploy).not.toBeNull();
    expect(deploy?.disabled).toBe(true);
    expect(deploy?.textContent).toBe("Up to date");
    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).toBeNull();

    await click(deploy);
    expect(deployPosts()).toBe(0);
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).toBeNull();
  });

  test("first load: Ledger-owned orphans with an empty active catalog are no-op", async () => {
    installStubs();
    ledgerSkills = ["ghost-1", "ghost-2"];
    activeSkill = null;
    removedSkill = null;
    const host = await render();

    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).toBeNull();
    const deploy = host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement | null;
    expect(deploy).not.toBeNull();
    expect(deploy?.disabled).toBe(true);
    expect(deploy?.textContent).toBe("Up to date");
    await click(deploy);
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).toBeNull();
    expect(deployPosts()).toBe(0);
  });

  test("first diff after Ledger seed uses seeded selected names and targets", async () => {
    installStubs();
    ledgerSkills = ["alpha", "beta"];
    ledgerTargets = ["codex"];
    activeSkill = "alpha";
    const host = await render();

    expect(host.querySelector('[data-testid="kit-deploy"]')?.textContent).toBe("Up to date");
    const firstDiff = diffCalls()[0];
    expect(firstDiff).toBeDefined();
    const selection = parseSelection(firstDiff?.body);
    expect(selection.add.skills).toEqual(["alpha", "beta"]);
    expect(selection.targets).toEqual(["codex"]);
  });

  test("Deploy is disabled while the diff is still loading and does not POST", async () => {
    installStubs();
    activeSkill = "alpha";
    deferDiff = true;
    const host = await render();

    const deploy = host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement | null;
    expect(deploy).not.toBeNull();
    expect(deploy?.disabled).toBe(true);
    expect(diffCalls()).toHaveLength(1);

    await click(deploy);
    expect(deployPosts()).toBe(0);
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).toBeNull();

    await releaseDiff();
    expect(deploy?.textContent).toBe("Up to date");
  });

  test("an already-armed removal confirm cannot POST while the diff is refetching", async () => {
    installStubs();
    ledgerSkills = ["alpha"];
    activeSkill = "alpha";
    removedSkill = "alpha";
    const host = await render();

    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));
    await click(host.querySelector('[data-testid="kit-deploy"]'));
    const confirm = host.querySelector(
      '[data-testid="kit-deploy-confirm"]',
    ) as HTMLButtonElement | null;
    expect(confirm).not.toBeNull();
    expect(confirm?.disabled).toBe(false);

    deferDiff = true;
    await click(host.querySelector('[data-testid="kit-check-updates"]'));
    expect(confirm?.disabled).toBe(true);

    await click(confirm);
    expect(deployPosts()).toBe(0);

    await releaseDiff();
    expect(confirm?.disabled).toBe(false);
  });
});
