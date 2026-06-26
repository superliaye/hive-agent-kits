// #47 data-loss guard (UI): a removal-bearing Deploy is gated behind an explicit
// two-step confirm, with a plain-language danger banner above the Deploy button.
// And the first-load regression: a Ledger holding capabilities whose Sources are
// not active (absent from the server-side active catalog) yields a diff with zero
// "removed" — so the page opens with NO removal warning and Deploy is NOT gated.
//
// The server is authoritative for the diff (#47 fixes computeDiff/reconcilePrune);
// these tests stub the diff endpoint to drive the two UI states.

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

type Call = { method: string; path: string };
let calls: Call[];
// When set, the diff endpoint returns a "removed" entry for the named skill so the
// Deploy is removal-bearing; otherwise the diff is empty (no removals).
let removedSkill: string | null;
// Ledger names to seed the page's selection on first load.
let ledgerSkills: string[];
// Names the active catalog provides (drives both the catalog rows and the diff's
// removed set: a selected name NOT in this set is an orphan → never "removed").
let activeSkill: string | null;
// When true, the diff endpoint hangs until `releaseDiff()` is called — lets a test
// hold the diff in-flight and assert Deploy is gated during that refetch window.
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
      agents: ["claude"],
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
    calls.push({ method, path });

    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources" && method === "GET") return json(sources());
    if (path === "/api/kit/diff" && method === "POST") {
      const entries =
        removedSkill !== null
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

describe("KitDeployPage — #47 removal confirm gate", () => {
  test("a removal-bearing Deploy does NOT POST on the first click; a confirm appears; confirm POSTs", async () => {
    installStubs();
    activeSkill = "alpha";
    removedSkill = "alpha";
    const host = await render();

    // Select the active capability so a diff is fetched (removal-bearing).
    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));

    // The plain-language danger banner is shown above Deploy.
    const warn = host.querySelector('[data-testid="kit-deploy-remove-warn"]');
    expect(warn).not.toBeNull();
    expect(warn?.textContent ?? "").toContain("DELETE");
    expect(warn?.textContent ?? "").toContain("1");

    // First Deploy click does NOT fire the mutation — it arms the confirm.
    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(deployPosts()).toBe(0);

    const confirm = host.querySelector('[data-testid="kit-deploy-confirm"]');
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent ?? "").toContain("Confirm");

    // Clicking confirm fires the deploy.
    await click(host.querySelector('[data-testid="kit-deploy-confirm"]'));
    expect(deployPosts()).toBe(1);
  });

  test("a zero-removals Deploy POSTs on the first click (no extra friction)", async () => {
    installStubs();
    activeSkill = "alpha";
    removedSkill = null; // an added/changed-only diff, no removals
    const host = await render();

    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));
    // No removal warning, no confirm gate.
    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).toBeNull();

    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(deployPosts()).toBe(1);
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).toBeNull();
  });

  test("first load: a Ledger holding names absent from the active catalog shows 0 removed and no warning", async () => {
    installStubs();
    // The active catalog provides nothing the ledger owns (those Sources are
    // inactive/absent). The page seeds its selection from the ledger; the server's
    // #47 fix yields an empty removed set, so no warning, no gate.
    ledgerSkills = ["ghost-1", "ghost-2"];
    activeSkill = null;
    removedSkill = null;
    const host = await render();

    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).toBeNull();
    // Deploy fires directly (no confirm gate) since there are zero removals.
    await click(host.querySelector('[data-testid="kit-deploy"]'));
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).toBeNull();
    expect(deployPosts()).toBe(1);
  });

  test("Deploy is gated while the diff is still loading (no confirm-bypass mid-refetch)", async () => {
    installStubs();
    activeSkill = "alpha";
    removedSkill = "alpha"; // the loaded diff WILL be removal-bearing
    deferDiff = true; // ...but hold it in-flight
    const host = await render();

    // Select the capability: the diff fetch starts but the stub is gated, so
    // diffQuery.data is undefined and removedCount reads 0 — the exact window
    // where the old code let a Deploy click fire with no confirm.
    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));

    const deploy = host.querySelector('[data-testid="kit-deploy"]') as HTMLButtonElement | null;
    expect(deploy).not.toBeNull();
    expect(deploy?.disabled).toBe(true);

    // Clicking Deploy in this window must NOT deploy (and must NOT have skipped a
    // confirm). No POST /api/kit/deploy.
    await click(deploy);
    expect(deployPosts()).toBe(0);
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).toBeNull();

    // Once the diff settles (removal-bearing), Deploy enables and arms the gate.
    await releaseDiff();
    expect(deploy?.disabled).toBe(false);
    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).not.toBeNull();
    await click(deploy);
    expect(deployPosts()).toBe(0); // first click arms, does not deploy
    expect(host.querySelector('[data-testid="kit-deploy-confirm"]')).not.toBeNull();
  });
});
