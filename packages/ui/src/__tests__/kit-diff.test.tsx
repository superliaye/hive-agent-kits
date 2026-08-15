// #53 Deploy Diff visual treatment (UI). The diff panel is a collapsible,
// count-bearing summary (collapsed by default) so the catalog holds prime fold;
// only populated buckets render (no marooned empty columns); removed rows carry
// row-level danger so a destructive deploy is legible from the rows, not only the
// column header.
//
// The server is authoritative for the diff; this test stubs the diff endpoint to
// drive a one-sided (removed-only) diff and asserts the panel's structure.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CapabilityEntry,
  Catalog,
  DiffEntry,
  KitState,
  Source,
  VerifyReport,
} from "../api.ts";
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

const GIT_ID = "git-src";
const GIT_ORIGIN = "https://github.com/owner/repo";
const OTHER_ID = "other-src";
const OTHER_ORIGIN = "https://github.com/owner/repo-b";

// The diff entries the stubbed /api/kit/diff endpoint returns for this render.
let diffEntries: DiffEntry[];
let ledgerInstructions: string[];

function sources(): Source[] {
  return [
    {
      id: GIT_ID,
      label: "owner/repo",
      locator: {
        kind: "git",
        repoUrl: GIT_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: GIT_ORIGIN,
      kind: "git",
      active: true,
      createdAt: 1,
      rank: 0,
    },
    {
      id: OTHER_ID,
      label: "owner/repo-b",
      locator: {
        kind: "git",
        repoUrl: OTHER_ORIGIN,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: OTHER_ORIGIN,
      kind: "git",
      active: true,
      createdAt: 2,
      rank: 1,
    },
  ];
}

function catalog(): Catalog {
  const entries: CapabilityEntry[] = [
    {
      kind: "instruction",
      name: "global-rule",
      description: "an active instruction capability",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: [GIT_ID],
      contentSha: "d".repeat(64),
    },
    {
      kind: "skill",
      name: "alpha",
      description: "an active capability",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: [GIT_ID],
      contentSha: "a".repeat(64),
    },
    {
      kind: "skill",
      name: "priority-tool",
      description: "winning duplicate capability",
      group: "",
      deployable: true,
      shadowed: false,
      sourceIds: [OTHER_ID],
      contentSha: "b".repeat(64),
    },
    {
      kind: "skill",
      name: "priority-tool",
      description: "hidden duplicate capability",
      group: "",
      deployable: false,
      shadowed: true,
      sourceIds: [GIT_ID],
      contentSha: "c".repeat(64),
      shadowedBy: OTHER_ID,
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
      {
        state: "up_to_date",
        sha: "def5678abc",
        fetchedAt: 1,
        sourceId: OTHER_ID,
        origin: OTHER_ORIGIN,
      },
    ],
    ledger: {
      kitVersion: "1.0.0",
      agents: ["claude"],
      skills: [],
      agentDefs: [],
      instructions: ledgerInstructions.map((name) => ({ name })),
      plugins: [],
      bundles: [],
    },
  };
}

function installStubs(): void {
  diffEntries = [];
  ledgerInstructions = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/kit/overview")
      return json(
        overviewFromLegacy({
          catalog: catalog(),
          state: kitState(),
          sources: sources(),
          diff: { entries: diffEntries },
        }),
      );
    if (path === "/api/kit/selection" && method === "PATCH")
      return json({ revision: 8, enabled: [], removalIntents: [] });
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources" && method === "GET") return json(sources());
    if (path === "/api/kit/diff" && method === "POST") return json({ entries: diffEntries });
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

// Select the active capability so a diff is fetched and the panel renders.
async function renderWithDiff(entries: DiffEntry[]): Promise<HTMLElement> {
  installStubs();
  diffEntries = entries;
  const host = await render();
  await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));
  return host;
}

describe("KitDeployPage — #53 Deploy Diff visual treatment", () => {
  test("a one-sided (removed-only) diff renders only the removed bucket, no marooned empty columns", async () => {
    const host = await renderWithDiff([
      { kind: "skill", name: "alpha", change: "removed", replacesUserFile: false },
    ]);

    const panel = host.querySelector('[data-testid="kit-diff"]');
    expect(panel).not.toBeNull();

    // Expand to reveal the bucket columns.
    await click(host.querySelector('[data-testid="kit-diff-toggle"]'));

    expect(host.querySelector('[data-testid="kit-diff-removed"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-diff-added"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-diff-changed"]')).toBeNull();
  });

  test("removed rows carry the row-level danger hook, distinct from added/changed", async () => {
    const host = await renderWithDiff([
      { kind: "skill", name: "alpha", change: "removed", replacesUserFile: false },
      { kind: "skill", name: "beta", change: "added", replacesUserFile: false },
    ]);
    await click(host.querySelector('[data-testid="kit-diff-toggle"]'));

    const removedCol = host.querySelector('[data-testid="kit-diff-removed"]');
    const addedCol = host.querySelector('[data-testid="kit-diff-added"]');
    expect(removedCol).not.toBeNull();
    expect(addedCol).not.toBeNull();

    // The row-level danger styling hook is the `kit-diff-removed` class on the
    // column that owns the rows (CSS targets `.kit-diff-removed li`). The added
    // column does not carry it, so the rows are styled distinctly.
    expect(removedCol?.classList.contains("kit-diff-removed")).toBe(true);
    expect(addedCol?.classList.contains("kit-diff-removed")).toBe(false);

    // The removed bucket's rows are present under that danger-styling column.
    expect(removedCol?.querySelectorAll("li").length).toBe(1);
  });

  test("the panel is a collapsible, count-bearing summary — collapsed by default, toggle reveals the rows", async () => {
    const host = await renderWithDiff([
      { kind: "skill", name: "alpha", change: "removed", replacesUserFile: false },
      { kind: "skill", name: "beta", change: "added", replacesUserFile: false },
      { kind: "skill", name: "gamma", change: "changed", replacesUserFile: false },
    ]);

    // The summary is present and bears the counts.
    const summary = host.querySelector('[data-testid="kit-diff-summary"]');
    expect(summary).not.toBeNull();
    const summaryText = summary?.textContent ?? "";
    expect(summaryText).toContain("1"); // each bucket has one entry
    expect(summaryText).toContain("−1"); // removed count, danger-colored

    // Collapsed by default: the bucket columns are not rendered.
    expect(host.querySelector('[data-testid="kit-diff-removed"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-diff-added"]')).toBeNull();
    expect(host.querySelector('[data-testid="kit-diff-changed"]')).toBeNull();

    const toggle = host.querySelector('[data-testid="kit-diff-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    // Clicking the toggle reveals the bucket rows.
    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-testid="kit-diff-removed"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-diff-added"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-diff-changed"]')).not.toBeNull();
  });

  test("the CLAUDE.md-replacement warning stays visible while the panel is collapsed", async () => {
    const host = await renderWithDiff([
      { kind: "instruction", name: "CLAUDE", change: "changed", replacesUserFile: true },
    ]);

    // The panel is collapsed (no bucket columns) but the destructive-overwrite
    // warning is surfaced regardless — it is not buried behind the toggle.
    expect(host.querySelector('[data-testid="kit-diff-changed"]')).toBeNull();
    const warn = host.querySelector('[data-testid="kit-diff-userfile-warn"]');
    expect(warn).not.toBeNull();
    expect(warn?.textContent ?? "").toContain("CLAUDE.md");
  });

  test("expanded review shows targets, Source labels, and hidden duplicate context", async () => {
    const host = await renderWithDiff([
      { kind: "skill", name: "priority-tool", change: "changed", replacesUserFile: false },
    ]);

    await click(host.querySelector('[data-testid="kit-diff-toggle"]'));

    const review = host.querySelector('[data-testid="kit-diff-review"]');
    expect(review?.textContent ?? "").toContain("Changed 1");

    const source = host.querySelector('[data-testid="kit-diff-sources-priority-tool"]');
    expect(source?.textContent ?? "").toContain("owner/repo-b");

    const hidden = host.querySelector('[data-testid="kit-diff-hidden-priority-tool"]');
    expect(hidden?.textContent ?? "").toContain("Hidden duplicate from owner/repo");
    expect(hidden?.textContent ?? "").toContain("owner/repo-b wins by Source precedence");
  });

  test("expanded review names Sources for the synthetic instruction changed row", async () => {
    installStubs();
    ledgerInstructions = ["global-rule"];
    diffEntries = [
      { kind: "instruction", name: "(CLAUDE.md)", change: "changed", replacesUserFile: true },
    ];
    const host = await render();

    await click(host.querySelector('[data-testid="kit-diff-toggle"]'));

    const source = host.querySelector('[data-testid="kit-diff-sources-(CLAUDE.md)"]');
    expect(source?.textContent ?? "").toContain("owner/repo");
  });
});
