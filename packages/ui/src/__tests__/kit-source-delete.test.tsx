// Remove on an added Source's card. Every added Source offers it: user-added git
// Sources and the bundled Starter (kind:"local") alike (ADR-0023). The first click
// only arms an inline confirm; the confirm turns off the selected Capabilities
// only that Source provides, then fires DELETE /api/sources/:id. On success the
// page refetches the Overview, so the card and its capabilities disappear.
// Cancel dismisses the confirm with no DELETE.
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

const STARTER_ID = "starter-local";
const GIT_ID = "git-src";
const STARTER_ORIGIN = "https://github.com/superliaye/my-agent-kits";
const GIT_ORIGIN = "https://github.com/owner/repo";
// The toast/label form of an origin (shortOrigin): last two path segments.
const STARTER_LABEL = "superliaye/my-agent-kits";

type Call = { method: string; path: string; body: string | undefined };
let calls: Call[];
// Mutable set of deleted Source ids — the whole mock derives from this so a DELETE
// is reflected by every subsequent GET (sources/catalog/state), mirroring the live
// server dropping the registry row + its catalog entries.
let deleted: Set<string>;
// When set, the DELETE endpoint 500s — to exercise the delete error banner.
let failDelete: boolean;
// When set, the registry holds ONLY the bundled Starter (no git Source) — so
// deleting the Starter empties the Sources list and exercises the empty-state.
let onlyStarter: boolean;
// When set, the Starter also ships alpha, so alpha outlives the git Source.
let starterShipsAlpha: boolean;
// Selected and deployed keys ("skill:alpha"). A deployed key that is no longer
// selected is a removal in the Deploy diff.
let desired: Set<string>;
let deployed: Set<string>;

function sources(): Source[] {
  const all: Source[] = [
    {
      id: STARTER_ID,
      label: STARTER_LABEL,
      locator: { kind: "starter" },
      origin: STARTER_ORIGIN,
      kind: "local",
      active: true,
      createdAt: 1,
      rank: 0,
    },
  ];
  if (!onlyStarter) {
    all.push({
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
      createdAt: 2,
      rank: 1,
    });
  }
  return all.filter((s) => !deleted.has(s.id));
}

// One git-provided skill. Omitted from the catalog once its Source is deleted (the
// server builds the catalog from the surviving active sources only).
function catalog(): Catalog {
  const entries: CapabilityEntry[] =
    onlyStarter || deleted.has(GIT_ID)
      ? []
      : [
          {
            kind: "skill",
            name: "alpha",
            description: "a git capability",
            group: "",
            deployable: true,
            shadowed: false,
            sourceIds: starterShipsAlpha ? [GIT_ID, STARTER_ID] : [GIT_ID],
            contentSha: "a".repeat(64),
          },
        ];
  return { entries, presets: [], problems: [] };
}

function kitState(): KitState {
  const sync = [];
  if (!deleted.has(STARTER_ID)) {
    sync.push({
      state: "local" as const,
      sha: null,
      fetchedAt: 1,
      sourceId: STARTER_ID,
      origin: STARTER_ORIGIN,
    });
  }
  if (!onlyStarter && !deleted.has(GIT_ID)) {
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
  deleted = new Set();
  failDelete = false;
  onlyStarter = false;
  starterShipsAlpha = false;
  desired = new Set();
  deployed = new Set();
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path, body });

    if (path === "/api/kit/overview") {
      const removed = [...deployed].filter((id) => !desired.has(id));
      return json(
        overviewFromLegacy({
          catalog: catalog(),
          state: kitState(),
          sources: sources(),
          desired,
          diff: {
            entries: removed.map((id) => ({
              kind: "skill" as const,
              name: id.slice(id.indexOf(":") + 1),
              change: "removed" as const,
            })),
          },
        }),
      );
    }
    if (path === "/api/kit/selection" && method === "PATCH") {
      const mutation = JSON.parse(body ?? "{}") as {
        changes: Array<{ key: { kind: string; name: string }; enabled: boolean }>;
      };
      for (const change of mutation.changes) {
        const id = `${change.key.kind}:${change.key.name}`;
        if (change.enabled) desired.add(id);
        else desired.delete(id);
      }
      return json({ revision: 8, enabled: [], removalIntents: [] });
    }
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/sources" && method === "GET") return json(sources());

    // Single path segment only — never a sub-route like …/activate.
    const del = path.match(/^\/api\/sources\/([^/]+)$/);
    if (del && method === "DELETE") {
      if (failDelete) return new Response("nope", { status: 500, statusText: "Server Error" });
      const id = decodeURIComponent(del[1] ?? "");
      deleted.add(id);
      return new Response(null, { status: 204 });
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

describe("KitDeployPage — Remove on a Source card", () => {
  test("a Remove control renders for the git Source AND for the bundled local Starter", async () => {
    installStubs();
    const host = await render();
    expect(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`)).not.toBeNull();
    // The Starter row exposes the same Remove trigger as a git Source.
    expect(host.querySelector(`[data-testid="kit-source-delete-${STARTER_ID}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).not.toBeNull();
  });

  test("Remove → confirm → DELETE fires and the Source row + its capability rows disappear after the refetch", async () => {
    installStubs();
    const host = await render();
    // The git capability is present initially.
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();

    // First click only ARMS — no DELETE yet; the confirm control appears.
    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const confirm = host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`);
    expect(confirm).not.toBeNull();

    // Confirm fires DELETE /api/sources/:id.
    await click(confirm);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/sources/${GIT_ID}`)).toBe(
      true,
    );

    // After the ["sources"]/["kit"] refetch the row AND its capability are gone.
    expect(host.querySelector(`[data-testid="kit-source-${GIT_ID}"]`)).toBeNull();
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).toBeNull();
    // The other Source (the Starter) is untouched; deleting one Source leaves the
    // rest of the list intact.
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).not.toBeNull();
  });

  test("Starter delete: Remove → confirm fires DELETE /api/sources/<STARTER_ID>, the row disappears, and a success toast fires", async () => {
    installStubs();
    const host = await render();
    // The Starter row is present initially.
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).not.toBeNull();

    // First click only ARMS — no DELETE yet; the confirm control appears.
    await click(host.querySelector(`[data-testid="kit-source-delete-${STARTER_ID}"]`));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const confirm = host.querySelector(`[data-testid="kit-source-delete-confirm-${STARTER_ID}"]`);
    expect(confirm).not.toBeNull();

    // Confirm fires DELETE /api/sources/<STARTER_ID>.
    await click(confirm);
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === `/api/sources/${STARTER_ID}`),
    ).toBe(true);

    // After the ["sources"]/["kit"] refetch the Starter row is gone.
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).toBeNull();

    // The same success toast as a git Source: `Removed <origin>`.
    const toast = host.querySelector('[data-testid="toast-success"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain(`Removed ${STARTER_LABEL}`);
  });

  test("deleting the only/last Source leaves a clean empty Sources list with no crash", async () => {
    installStubs();
    onlyStarter = true;
    const host = await render();
    // The Starter is the sole Source.
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).not.toBeNull();

    await click(host.querySelector(`[data-testid="kit-source-delete-${STARTER_ID}"]`));
    await click(host.querySelector(`[data-testid="kit-source-delete-confirm-${STARTER_ID}"]`));

    expect(
      calls.some((c) => c.method === "DELETE" && c.path === `/api/sources/${STARTER_ID}`),
    ).toBe(true);

    // The card is gone, the empty state shows (the genuinely-no-sources case, not
    // all-off), and the shelf still offers adding a Source by its link.
    expect(host.querySelector(`[data-testid="kit-source-${STARTER_ID}"]`)).toBeNull();
    expect(host.querySelector('[data-testid="kit-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="add-source-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-empty-disabled"]')).toBeNull();
  });

  test("Cancel dismisses the confirm and fires no DELETE", async () => {
    installStubs();
    const host = await render();

    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    const cancel = host.querySelector(`[data-testid="kit-source-delete-cancel-${GIT_ID}"]`);
    expect(cancel).not.toBeNull();

    await click(cancel);
    // No DELETE, the confirm is gone, the Remove trigger is back, the row stays.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`)).toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-${GIT_ID}"]`)).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();
  });

  test("a failed delete surfaces an error banner and leaves the Source + its capabilities in place", async () => {
    installStubs();
    failDelete = true;
    const host = await render();

    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    await click(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`));

    // The DELETE was attempted and failed → a visible error banner, and the Source
    // row + its capability stay present (the refetch returns the unchanged list).
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/sources/${GIT_ID}`)).toBe(
      true,
    );
    expect(host.querySelector('[data-testid="kit-source-delete-error"]')).not.toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-${GIT_ID}"]`)).not.toBeNull();
    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')).not.toBeNull();
    // The row auto-disarms after the failure: the confirm is gone and the Remove
    // trigger is back (the user is not left stuck in an armed state).
    expect(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`)).toBeNull();
    expect(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`)).not.toBeNull();
  });
  test("Remove turns off the selected Capabilities only that Source provides, then deletes it", async () => {
    installStubs();
    const host = await render();
    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));

    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    expect(
      host.querySelector(`[data-testid="kit-source-delete-arm-${GIT_ID}"]`)?.textContent,
    ).toContain("Its 1 selected Capability turns off, and your next Deploy uninstalls it.");
    await click(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`));

    const mutations = calls.filter((c) => c.method !== "GET");
    expect(mutations.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /api/kit/selection",
      "PATCH /api/kit/selection",
      `DELETE /api/sources/${GIT_ID}`,
    ]);
    expect(JSON.parse(mutations[1]?.body ?? "null").changes).toEqual([
      { key: { kind: "skill", name: "alpha" }, enabled: false, targets: ["claude"] },
    ]);
  });

  test("a Capability another Source also provides stays selected", async () => {
    installStubs();
    starterShipsAlpha = true;
    const host = await render();
    await click(host.querySelector('[data-testid="kit-row-skill-alpha"]'));

    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    expect(
      host.querySelector(`[data-testid="kit-source-delete-arm-${GIT_ID}"]`)?.textContent,
    ).not.toContain("turns off");
    await click(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`));

    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /api/kit/selection",
      `DELETE /api/sources/${GIT_ID}`,
    ]);
    expect(desired.has("skill:alpha")).toBe(true);
  });

  test("after removing a Source, Deploy warns before it deletes the deployed Capability", async () => {
    installStubs();
    desired = new Set(["skill:alpha"]);
    deployed = new Set(["skill:alpha"]);
    const host = await render();
    expect(host.querySelector('[data-testid="kit-deploy-remove-warn"]')).toBeNull();

    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    await click(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`));

    const warn = host.querySelector('[data-testid="kit-deploy-remove-warn"]');
    expect(warn?.textContent).toContain("DELETE");
    expect(warn?.textContent).toContain("1");
  });
});

describe("KitDeployPage — added Source cards", () => {
  test("a SHA-less Source (the bundled Starter) renders a labeled 'no identity', not a bare dash", async () => {
    installStubs();
    const host = await render();
    const sha = host.querySelector(`[data-testid="kit-sha-${GIT_ID}"]`);
    expect(sha?.textContent).toBe("abc1234");
    expect(sha?.className).not.toContain("kit-sha-empty");
    const starterSha = host.querySelector(`[data-testid="kit-sha-${STARTER_ID}"]`);
    expect(starterSha?.textContent).toBe("no identity");
    expect(starterSha?.className).toContain("kit-sha-empty");
  });

  test("per-capability target observations coexist with global target controls", async () => {
    installStubs();
    const host = await render();
    const rail = host.querySelector('[data-testid="kit-state-skill-alpha"]');
    expect(rail?.textContent).toContain("Claude");
    expect(rail?.textContent).toContain("Codex");
    expect(host.querySelector('[data-testid="kit-target-claude"]')?.className).toContain(
      "kit-target-check",
    );
  });
});
