// Source precedence on capability rows. A shadowed row explains itself:
// "Hidden — also provided by <Source>" derived from `shadowedBy`. A merged entry
// shows all contributing Source labels. The stub derives the winner from the two
// Sources' ranks.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source } from "../api.ts";
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

const A_ID = "src-a";
const B_ID = "src-b";
const A_ORIGIN = "https://github.com/owner/repo-a";
const B_ORIGIN = "https://github.com/owner/repo-b";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// Rank per Source id.
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
      { state: "up_to_date", sha: "aaa1111", fetchedAt: 1, sourceId: A_ID },
      { state: "up_to_date", sha: "bbb2222", fetchedAt: 1, sourceId: B_ID },
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

    if (path === "/api/kit/overview")
      return json(
        overviewFromLegacy({ catalog: catalog(), state: kitState(), sources: sources() }),
      );
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/sources" && method === "GET") return json(sources());

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
        createElement(KitDeployPage, { apiConfig, active: true }),
      ),
    );
  });
  await flush();
  return host;
}

describe("KitDeployPage — Source precedence on capability rows", () => {
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
});
