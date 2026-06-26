// Source on/off toggle (#37 / AC4): the Capabilities header renders one toggle per
// Source (incl. the bundled Starter, kind:"local") from GET /api/sources joined
// with state.sync. Deactivating a Source POSTs …/deactivate and — because the
// catalog is server-side active-only — its capabilities disappear live (the page
// re-fetches the catalog) while the Source's row stays visible (muted, inactive)
// for re-activation. Re-activating POSTs …/activate and the capabilities return.
// Selection is name-based + source-agnostic (ADR-0023): a selected capability is
// NOT pruned client-side on toggle-off and re-appears selected after re-activation.

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

const STARTER_ID = "starter-local";
const GIT_ID = "git-src";
const STARTER_ORIGIN = "https://github.com/superliaye/my-agent-kits";
const GIT_ORIGIN = "https://github.com/owner/repo";

type Call = { method: string; path: string };
let calls: Call[];
// Mutable set of deactivated Source ids — the whole mock derives from this so a
// deactivate/activate POST is reflected by every subsequent GET (catalog/state/
// sources), mirroring the live server's active-only catalog + state.sync.
let inactive: Set<string>;
// When set, the deactivate endpoint 500s — to exercise the toggle error banner.
let failDeactivate: boolean;

function sources(): Source[] {
  return [
    {
      id: STARTER_ID,
      origin: STARTER_ORIGIN,
      kind: "local",
      active: !inactive.has(STARTER_ID),
      createdAt: 1,
    },
    { id: GIT_ID, origin: GIT_ORIGIN, kind: "git", active: !inactive.has(GIT_ID), createdAt: 2 },
  ];
}

// One git-provided skill. Omitted from the catalog when its Source is inactive
// (the server builds the catalog from active sources only).
function catalog(): Catalog {
  const entries: CapabilityEntry[] = inactive.has(GIT_ID)
    ? []
    : [
        {
          kind: "skill",
          name: "alpha",
          description: "a git capability",
          group: "",
          deployable: true,
          shadowed: false,
          sourceIds: [GIT_ID],
          contentSha: "a".repeat(64),
        },
      ];
  return { entries, presets: [], problems: [] };
}

// state.sync is active-only: a deactivated Source drops out of it entirely.
function kitState(): KitState {
  const sync = [];
  if (!inactive.has(STARTER_ID)) {
    sync.push({
      state: "local" as const,
      sha: null,
      fetchedAt: 1,
      sourceId: STARTER_ID,
      origin: STARTER_ORIGIN,
    });
  }
  if (!inactive.has(GIT_ID)) {
    sync.push({
      state: "up_to_date" as const,
      sha: "abc1234def",
      fetchedAt: 1,
      sourceId: GIT_ID,
      origin: GIT_ORIGIN,
    });
  }
  return { sync, ledger: null };
}

function installStubs(): void {
  calls = [];
  inactive = new Set();
  failDeactivate = false;
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
    // Selecting a capability triggers the Deploy Diff fetch. This mock returns a
    // "removed" entry for the still-selected capability once its Source is inactive,
    // to exercise the general removal warning + confirm gate (#47/q3a). (The live
    // server, post-#47, keeps an owned-but-absent orphan OUT of the removed set.)
    if (path === "/api/kit/diff" && method === "POST") {
      const entries = inactive.has(GIT_ID)
        ? [{ kind: "skill", name: "alpha", change: "removed", replacesUserFile: false }]
        : [];
      return json({ entries });
    }
    if (path === "/api/sources" && method === "GET") return json(sources());

    const deact = path.match(/^\/api\/sources\/(.+)\/deactivate$/);
    if (deact && method === "POST") {
      if (failDeactivate) return new Response("nope", { status: 500, statusText: "Server Error" });
      const id = decodeURIComponent(deact[1] ?? "");
      inactive.add(id);
      return json(sources().find((s) => s.id === id));
    }
    const act_ = path.match(/^\/api\/sources\/(.+)\/activate$/);
    if (act_ && method === "POST") {
      const id = decodeURIComponent(act_[1] ?? "");
      inactive.delete(id);
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

describe("KitDeployPage — Source on/off toggle (AC4)", () => {
  test("both the git Source and the bundled Starter render an enabled toggle", async () => {
    installStubs();
    const host = await render();
    const gitToggle = host.querySelector(
      `[data-testid="kit-source-toggle-${GIT_ID}"]`,
    ) as HTMLInputElement | null;
    const starterToggle = host.querySelector(
      `[data-testid="kit-source-toggle-${STARTER_ID}"]`,
    ) as HTMLInputElement | null;
    expect(gitToggle).not.toBeNull();
    expect(starterToggle).not.toBeNull();
    // The Starter is toggleable, not locked (decision #3).
    expect(starterToggle?.disabled).toBe(false);
    expect(gitToggle?.checked).toBe(true);
    expect(starterToggle?.checked).toBe(true);
  });

  test("toggling a Source off POSTs …/deactivate, removes its capabilities live, keeps its row visible with origin", async () => {
    installStubs();
    const host = await render();
    // The git capability is present initially.
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();

    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));

    // A deactivate POST was issued; no add (POST /api/sources) or DELETE.
    expect(
      calls.some((c) => c.method === "POST" && c.path === `/api/sources/${GIT_ID}/deactivate`),
    ).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/sources")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // Its capability rows are gone from the catalog…
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).toBeNull();
    // …but its Source row is still present (now inactive) with origin label, even
    // though it left state.sync (proves the inactive-row renders from Source.origin).
    const row = host.querySelector(`[data-testid="kit-source-${GIT_ID}"]`);
    expect(row).not.toBeNull();
    expect(row?.className).toContain("kit-source-row-inactive");
    expect(row?.querySelector(".kit-source-origin")?.textContent).toBe("owner/repo");
  });

  test("re-activating an inactive Source POSTs …/activate and re-adds its capabilities", async () => {
    installStubs();
    const host = await render();
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).toBeNull();

    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    expect(
      calls.some((c) => c.method === "POST" && c.path === `/api/sources/${GIT_ID}/activate`),
    ).toBe(true);
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();
  });

  test("a selected capability is NOT pruned on toggle-off and re-appears selected after re-activation; no crash", async () => {
    installStubs();
    const host = await render();
    // Select the git capability.
    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')?.className).toContain(
      "selected",
    );

    // Toggle its Source off (row leaves the catalog) then back on.
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).toBeNull();
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));

    // The capability returns and is STILL selected (selection survived the round-trip).
    const row = host.querySelector('[data-testid="kit-row-skill-alpha"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain("selected");
    // The page did not crash — the deploy button is still present.
    expect(host.querySelector('[data-testid="kit-deploy"]')).not.toBeNull();
  });

  test("deactivating all Sources shows the all-disabled empty message with the rows still visible", async () => {
    installStubs();
    const host = await render();
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    await click(host.querySelector(`[data-testid="kit-source-toggle-${STARTER_ID}"]`));

    // Distinct all-disabled message (not the never-synced "Check for updates" copy).
    const disabled = host.querySelector('[data-testid="kit-empty-disabled"]');
    expect(disabled).not.toBeNull();
    expect(disabled?.textContent).toContain("All Sources are disabled");
    expect(host.querySelector('[data-testid="kit-empty"]')).toBeNull();

    // Both Source rows remain for re-activation, with their toggles.
    expect(host.querySelector(`[data-testid="kit-source-${GIT_ID}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`)).not.toBeNull();
  });

  test("with a selected capability now in the removed diff, the general removal warning shows (replaces the old disabled-Source banner, #47/q3a)", async () => {
    installStubs();
    const host = await render();
    // Select the git capability, then disable its Source — it survives selection
    // (not pruned). NB: post-#47 the server keeps an owned-but-absent orphan out of
    // the removed set; this mock still returns a removed entry to exercise the
    // general removal warning + confirm gate the disabled-Source banner became.
    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));

    // The obsolete disabled-Source banner is gone; the general removal warning shows.
    expect(host.querySelector('[data-testid="kit-deploy-disabled-warn"]')).toBeNull();
    const warn = host.querySelector('[data-testid="kit-deploy-remove-warn"]');
    expect(warn).not.toBeNull();
    expect(warn?.textContent).toContain("DELETE");
    expect(warn?.textContent).toContain("1");

    // Re-enabling the Source clears the warning (no removed diff, source active).
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).toBeNull();
  });

  test("a SHA-less Source (the bundled Starter) renders a labeled 'no SHA', not a bare dash (#54)", async () => {
    installStubs();
    const host = await render();
    // The Starter seeds first in registry order and is in state.sync, so it is the
    // anchor row carrying the bare kit-sha testid; its sync.sha is null.
    const sha = host.querySelector('[data-testid="kit-sha"]');
    expect(sha).not.toBeNull();
    expect(sha?.textContent).toBe("no SHA");
    expect(sha?.textContent).not.toBe("—");
    // The muted-absence treatment is applied via a class hook, not inline style.
    expect(sha?.className).toContain("kit-sha-empty");
    // A real SHA still renders short and carries no empty hook.
    const gitSha = host.querySelector(`[data-testid="kit-sha-${GIT_ID}"]`);
    expect(gitSha?.textContent).toBe("abc1234");
    expect(gitSha?.className).not.toContain("kit-sha-empty");
  });

  test("the deploy-target toggles use the app's custom control class, not a raw native checkbox (#54)", async () => {
    installStubs();
    const host = await render();
    for (const t of ["claude", "codex"]) {
      const check = host.querySelector(
        `[data-testid="kit-target-${t}"]`,
      ) as HTMLInputElement | null;
      expect(check).not.toBeNull();
      // Still a real checkbox for a11y…
      expect(check?.getAttribute("type")).toBe("checkbox");
      // …but wrapped in the custom accent-check vocabulary (class hook + the
      // shared .kit-target-toggle label), not a bare browser checkbox.
      expect(check?.className).toContain("kit-target-check");
      expect(check?.closest(".kit-target-toggle")).not.toBeNull();
    }
  });

  test("a failed toggle surfaces an error banner and leaves the capabilities in place", async () => {
    installStubs();
    failDeactivate = true;
    const host = await render();
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();

    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));

    // The deactivate was attempted and failed → a visible error banner, and the
    // capability stays present (no optimistic removal on a rejected toggle).
    expect(
      calls.some((c) => c.method === "POST" && c.path === `/api/sources/${GIT_ID}/deactivate`),
    ).toBe(true);
    expect(host.querySelector('[data-testid="kit-source-toggle-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();
  });
});
