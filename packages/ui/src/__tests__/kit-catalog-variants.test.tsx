// AggregatedCatalog rendering: the Kit Deploy page renders merge labels and
// the Shadowed badge as a third visible state distinct from blocked. Single-variant
// rows keep the stable `kit-row-${kind}-${name}` testid; a key with ≥2 variants
// keys each row uniformly by a short contentSha suffix.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source, VerifyReport } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";
import { overviewFromLegacy } from "./kit-overview-test-helpers.ts";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
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
const emptyState: KitState = { sync: [], ledger: null };

function entry(over: Partial<CapabilityEntry> & Pick<CapabilityEntry, "name">): CapabilityEntry {
  return {
    kind: "skill",
    description: "desc",
    group: "",
    deployable: true,
    shadowed: false,
    sourceIds: ["src-1"],
    contentSha: "a".repeat(64),
    ...over,
  };
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

async function renderCatalog(
  entries: CapabilityEntry[],
  state: KitState = emptyState,
  sourceLabels: Readonly<Record<string, string>> = {},
): Promise<HTMLElement> {
  const catalog: Catalog = { entries, presets: [], problems: [] };
  // The header sources query must resolve so the joined rows render; derive an
  // active git Source per state.sync entry (these tests assert row content,
  // not the toggle, so an empty list when state.sync is empty is fine).
  const sources: Source[] = state.sync.map((s, i) => ({
    id: s.sourceId,
    label: sourceLabels[s.sourceId] ?? s.sourceId,
    locator: {
      kind: "git",
      repoUrl: `https://example.invalid/${s.sourceId}`,
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    },
    origin: `https://example.invalid/${s.sourceId}`,
    kind: "git",
    active: true,
    createdAt: i,
    rank: i,
  }));
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/kit/overview") return json(overviewFromLegacy({ catalog, state, sources }));
    if (path === "/api/kit/catalog") return json(catalog);
    if (path === "/api/kit/state") return json(state);
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources") return json(sources);
    return json({});
  }) as typeof fetch;

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

describe("KitDeployPage — AggregatedCatalog variants", () => {
  test("a shadowed row is visible, badged 'not deployed (duplicate)', and non-selectable", async () => {
    const host = await renderCatalog([
      entry({ name: "foo", deployable: true, sourceIds: ["src-b"], contentSha: "b".repeat(64) }),
      entry({
        name: "foo",
        deployable: false,
        shadowed: true,
        sourceIds: ["src-a"],
        contentSha: "a".repeat(64),
      }),
    ]);
    // Both variants rendered (multi-variant testids by short sha).
    const winner = host.querySelector('[data-testid="kit-row-skill-foo-bbbbbbbb"]');
    const shadow = host.querySelector(
      '[data-testid="kit-row-skill-foo-aaaaaaaa"]',
    ) as HTMLButtonElement | null;
    expect(winner).not.toBeNull();
    expect(shadow).not.toBeNull();
    // Shadowed is visible (not blocked-styled) but disabled for selection.
    expect(shadow?.className).toContain("shadowed");
    expect(shadow?.className).not.toContain("blocked");
    expect(shadow?.disabled).toBe(true);
    const badge = shadow?.querySelector('[data-status="duplicate"]');
    expect(badge?.textContent).toBe("not deployed (duplicate)");
  });

  test("a merged row renders more than one Source label", async () => {
    const host = await renderCatalog([
      entry({ name: "merged", sourceIds: ["src-b", "src-a"], contentSha: "c".repeat(64) }),
    ]);
    const labels = host.querySelectorAll(
      '[data-testid="kit-row-sources-merged"] .kit-source-label',
    );
    expect(labels.length).toBe(2);
  });

  test("a merged row labels Sources by their human owner/repo, not the opaque id", async () => {
    const host = await renderCatalog(
      [entry({ name: "merged", sourceIds: ["src-b", "src-a"], contentSha: "c".repeat(64) })],
      {
        sync: [
          {
            state: "up_to_date",
            sha: "abc",
            fetchedAt: 1,
            sourceId: "src-a",
          },
          {
            state: "up_to_date",
            sha: "def",
            fetchedAt: 1,
            sourceId: "src-b",
          },
        ],
        ledger: null,
      },
      { "src-a": "owner/repo-a", "src-b": "owner/repo-b" },
    );
    const labels = [
      ...host.querySelectorAll('[data-testid="kit-row-sources-merged"] .kit-source-label'),
    ].map((el) => el.textContent);
    expect(new Set(labels)).toEqual(new Set(["owner/repo-a", "owner/repo-b"]));
  });

  test("a single-variant row keeps the stable kit-row-<kind>-<name> testid", async () => {
    const host = await renderCatalog([entry({ name: "solo" })]);
    expect(host.querySelector('[data-testid="kit-row-skill-solo"]')).not.toBeNull();
  });

  test("a key with ≥3 variants renders 3 distinct, uniformly-derived row testids", async () => {
    const host = await renderCatalog([
      entry({ name: "tri", deployable: true, sourceIds: ["s1"], contentSha: "11".repeat(32) }),
      entry({
        name: "tri",
        deployable: false,
        shadowed: true,
        sourceIds: ["s2"],
        contentSha: "22".repeat(32),
      }),
      entry({
        name: "tri",
        deployable: false,
        shadowed: true,
        sourceIds: ["s3"],
        contentSha: "33".repeat(32),
      }),
    ]);
    const ids = ["11111111", "22222222", "33333333"].map((s) =>
      host.querySelector(`[data-testid="kit-row-skill-tri-${s}"]`),
    );
    expect(ids.every((el) => el !== null)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  test("a blocked (malformed) row is disabled with its reason, distinct from shadowed", async () => {
    const host = await renderCatalog([
      entry({
        name: "bad",
        deployable: false,
        shadowed: false,
        blockedReason: "duplicate leaf name within kind",
      }),
    ]);
    const row = host.querySelector('[data-testid="kit-row-skill-bad"]') as HTMLButtonElement | null;
    expect(row?.className).toContain("blocked");
    expect(row?.className).not.toContain("shadowed");
    expect(row?.disabled).toBe(true);
    expect(row?.querySelector(".kit-row-blocked")?.textContent).toBe(
      "duplicate leaf name within kind",
    );
  });
});
