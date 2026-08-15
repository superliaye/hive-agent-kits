// Source precedence / re-rank UI + shadow explanation (#51).
//
// The Capabilities header renders its Sources in precedence order (highest rank
// first) and exposes per-Source move-up / move-down buttons. Clicking one POSTs
// /api/sources/:id/reorder and — because the catalog is recomputed from the new
// precedence — the winner flips live (the previously-shadowed variant deploys,
// the previously-winning one becomes shadowed). A shadowed row explains itself:
// "Hidden — also provided by <Source>" derived from `shadowedBy`. A merged entry
// shows all contributing Source labels (unchanged from #34).
//
// The stub is STATEFUL: it holds the two Sources' ranks and recomputes the
// catalog from them on every GET, so a reorder POST → refetch flips the winner.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source, VerifyReport } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";
import { overviewFromLegacy } from "./kit-overview-test-helpers.ts";

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

const A_ID = "src-a";
const B_ID = "src-b";
const A_ORIGIN = "https://github.com/owner/repo-a";
const B_ORIGIN = "https://github.com/owner/repo-b";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

type Call = { method: string; path: string; body?: string };
let calls: Call[];
// The mutable precedence: rank per Source id. A reorder swaps adjacent ranks.
let ranks: Map<string, number>;

function sources(): Source[] {
  return [
    {
      id: A_ID,
      label: "owner/repo-a",
      locator: {
        kind: "git",
        repoUrl: A_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: A_ORIGIN,
      kind: "git",
      active: true,
      createdAt: 1,
      rank: ranks.get(A_ID) ?? 0,
    },
    {
      id: B_ID,
      label: "owner/repo-b",
      locator: {
        kind: "git",
        repoUrl: B_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: B_ORIGIN,
      kind: "git",
      active: true,
      createdAt: 2,
      rank: ranks.get(B_ID) ?? 0,
    },
  ];
}

function kitState(): KitState {
  return {
    sync: [
      { state: "up_to_date", sha: "aaa1111", fetchedAt: 1, sourceId: A_ID, origin: A_ORIGIN },
      { state: "up_to_date", sha: "bbb2222", fetchedAt: 1, sourceId: B_ID, origin: B_ORIGIN },
    ],
    ledger: null,
  };
}

// Both Sources provide a same-key, different-content skill `foo`. The higher-rank
// Source wins (deployable); the other is shadowed with `shadowedBy` = the winner.
function catalog(): Catalog {
  const aRank = ranks.get(A_ID) ?? 0;
  const bRank = ranks.get(B_ID) ?? 0;
  const aWins = aRank > bRank;
  const winnerId = aWins ? A_ID : B_ID;
  const loserId = aWins ? B_ID : A_ID;
  const winnerSha = aWins ? SHA_A : SHA_B;
  const loserSha = aWins ? SHA_B : SHA_A;
  const entries: CapabilityEntry[] = [
    {
      kind: "skill",
      name: "foo",
      description: "the colliding skill",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: [winnerId],
      contentSha: winnerSha,
    },
    {
      kind: "skill",
      name: "foo",
      description: "the colliding skill",
      group: "",
      deployable: false,
      shadowed: true,
      sourceIds: [loserId],
      contentSha: loserSha,
      shadowedBy: winnerId,
    },
    // A merged entry: both Sources provide a byte-identical `bar` → one entry, 2 labels.
    {
      kind: "skill",
      name: "bar",
      description: "the merged skill",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: [winnerId, loserId],
      contentSha: "c".repeat(64),
    },
  ];
  return { entries, presets: [], problems: [] };
}

function installStubs(): void {
  calls = [];
  // A added first (rank 0), B added later (rank 1) → B wins by default.
  ranks = new Map([
    [A_ID, 0],
    [B_ID, 1],
  ]);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path, body });

    if (path === "/api/kit/overview")
      return json(
        overviewFromLegacy({ catalog: catalog(), state: kitState(), sources: sources() }),
      );
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources" && method === "GET") return json(sources());

    const reorder = path.match(/^\/api\/sources\/(.+)\/reorder$/);
    if (reorder && method === "POST") {
      const id = decodeURIComponent(reorder[1] ?? "");
      const direction = body ? (JSON.parse(body) as { direction: "up" | "down" }).direction : "up";
      const ordered = [...ranks.entries()].sort((x, y) => x[1] - y[1]).map(([k]) => k);
      const pos = ordered.indexOf(id);
      const neighborPos = direction === "up" ? pos + 1 : pos - 1;
      const neighbor = ordered[neighborPos];
      if (neighbor) {
        const a = ranks.get(id) ?? 0;
        const b = ranks.get(neighbor) ?? 0;
        ranks.set(id, b);
        ranks.set(neighbor, a);
      }
      return json(sources().find((s) => s.id === id));
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

describe("KitDeployPage — precedence re-rank + shadow explanation (#51)", () => {
  test("each Source row exposes move-up / move-down buttons, disabled at the ends", async () => {
    installStubs();
    const host = await render();
    // B wins (rank 1, highest) → rendered first (highest precedence first), its
    // move-up is disabled (already top); A's move-down is disabled (already bottom).
    const bUp = host.querySelector(
      `[data-testid="kit-source-up-${B_ID}"]`,
    ) as HTMLButtonElement | null;
    const aDown = host.querySelector(
      `[data-testid="kit-source-down-${A_ID}"]`,
    ) as HTMLButtonElement | null;
    expect(bUp).not.toBeNull();
    expect(aDown).not.toBeNull();
    expect(bUp?.disabled).toBe(true);
    expect(aDown?.disabled).toBe(true);
    // A can still move up; B can still move down.
    expect(
      (host.querySelector(`[data-testid="kit-source-up-${A_ID}"]`) as HTMLButtonElement | null)
        ?.disabled,
    ).toBe(false);
    expect(
      (host.querySelector(`[data-testid="kit-source-down-${B_ID}"]`) as HTMLButtonElement | null)
        ?.disabled,
    ).toBe(false);
  });

  test("the header renders Sources in precedence order (highest rank first)", async () => {
    installStubs();
    const host = await render();
    expect(host.querySelector(".kit-source-panel-title")?.textContent).toBe("Sources");
    expect(host.querySelector(".kit-source-panel-meta")?.textContent).toContain("Precedence order");
    const rowIds = [...host.querySelectorAll(".kit-source-row")].map((r) =>
      r.getAttribute("data-testid"),
    );
    // B (rank 1) before A (rank 0).
    expect(rowIds).toEqual([`kit-source-${B_ID}`, `kit-source-${A_ID}`]);
  });

  test("a shadowed row explains itself: 'Hidden — also provided by <winner label>'", async () => {
    installStubs();
    const host = await render();
    // A's variant of foo is shadowed by B (the winner). The explanation names B's
    // label. The shadow testid carries the variant's short contentSha suffix (a
    // shadowed row is always multi-variant), so match by prefix.
    const shadowNote = host.querySelector('[data-testid^="kit-row-shadow-foo-"]');
    expect(shadowNote).not.toBeNull();
    expect(shadowNote?.textContent).toContain("Hidden");
    expect(shadowNote?.textContent).toContain("Source precedence");
    expect(shadowNote?.textContent).toContain("higher Source precedence");
    expect(shadowNote?.textContent).toContain("owner/repo-b");
  });

  test("a merged entry still shows >1 contributing Source labels", async () => {
    installStubs();
    const host = await render();
    const labels = host.querySelectorAll('[data-testid="kit-row-sources-bar"] .kit-source-label');
    expect(labels.length).toBe(2);
  });

  test("move-up POSTs /reorder and the winner flips live: A becomes deployable, B shadowed, shadowedBy updates", async () => {
    installStubs();
    const host = await render();
    // Initially B wins. Raise A above B.
    await click(host.querySelector(`[data-testid="kit-source-up-${A_ID}"]`));

    // The POST was issued with {direction:"up"}.
    const reorderCall = calls.find(
      (c) => c.method === "POST" && c.path === `/api/sources/${A_ID}/reorder`,
    );
    expect(reorderCall).toBeDefined();
    expect(reorderCall?.body).toContain("up");

    // After the refetch, A's variant is deployable and B's is shadowed → the shadow
    // explanation now names A (owner/repo-a).
    const shadowNote = host.querySelector('[data-testid^="kit-row-shadow-foo-"]');
    expect(shadowNote?.textContent).toContain("owner/repo-a");

    // The header order flipped too: A (now rank 1) renders first.
    const rowIds = [...host.querySelectorAll(".kit-source-row")].map((r) =>
      r.getAttribute("data-testid"),
    );
    expect(rowIds).toEqual([`kit-source-${A_ID}`, `kit-source-${B_ID}`]);
  });
});
