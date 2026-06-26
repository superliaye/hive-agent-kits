// Transient action feedback (#50): the Capabilities tab pushes a toast when a
// previously-silent mutation resolves — sync (POST /api/kit/sync), Source
// activate/deactivate (…/activate, …/deactivate), and a confirmed delete
// (DELETE /api/sources/:id). Toasts complement, not replace, the persistent
// inline AddSourceStatus and the kit-source-toggle/delete error banners.
//
// Assertions check toast PRESENCE by data-testid; they do NOT depend on the
// ~4s auto-dismiss firing during the real-time flush() loop (which only
// advances 12 real-0ms ticks). Where dismissal is exercised it is driven by the
// explicit dismiss button, never the timer.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CapabilityEntry,
  Catalog,
  KitState,
  Source,
  SyncRunResult,
  VerifyReport,
} from "../api.ts";
import { KitDeployPage, syncToast } from "../pages/KitDeployPage.tsx";
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
let inactive: Set<string>;
let deleted: Set<string>;
// The POST /api/kit/sync result the stub returns for this test — swapped per
// scenario (all-unchanged, a failed Source, or a thrown sync).
let syncResult: SyncRunResult;
let failSync: boolean;

function sources(): Source[] {
  const all: Source[] = [
    {
      id: STARTER_ID,
      origin: STARTER_ORIGIN,
      kind: "local",
      active: !inactive.has(STARTER_ID),
      createdAt: 1,
    },
    { id: GIT_ID, origin: GIT_ORIGIN, kind: "git", active: !inactive.has(GIT_ID), createdAt: 2 },
  ];
  return all.filter((s) => !deleted.has(s.id));
}

function catalog(): Catalog {
  const entries: CapabilityEntry[] =
    inactive.has(GIT_ID) || deleted.has(GIT_ID)
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

function kitState(): KitState {
  const sync = [];
  if (!inactive.has(STARTER_ID) && !deleted.has(STARTER_ID)) {
    sync.push({
      state: "local" as const,
      sha: null,
      fetchedAt: 1,
      sourceId: STARTER_ID,
      origin: STARTER_ORIGIN,
    });
  }
  if (!inactive.has(GIT_ID) && !deleted.has(GIT_ID)) {
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
  deleted = new Set();
  failSync = false;
  syncResult = {
    sources: [
      { sourceId: STARTER_ID, origin: STARTER_ORIGIN, status: "unchanged" },
      { sourceId: GIT_ID, origin: GIT_ORIGIN, status: "unchanged" },
    ],
  };
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
    if (path === "/api/kit/diff" && method === "POST") return json({ entries: [] });
    if (path === "/api/sources" && method === "GET") return json(sources());

    if (path === "/api/kit/sync" && method === "POST") {
      if (failSync) return new Response("nope", { status: 500, statusText: "Server Error" });
      return json(syncResult);
    }

    const deact = path.match(/^\/api\/sources\/(.+)\/deactivate$/);
    if (deact && method === "POST") {
      const id = decodeURIComponent(deact[1] ?? "");
      inactive.add(id);
      return json(sources().find((s) => s.id === id) ?? {});
    }
    const act_ = path.match(/^\/api\/sources\/(.+)\/activate$/);
    if (act_ && method === "POST") {
      const id = decodeURIComponent(act_[1] ?? "");
      inactive.delete(id);
      return json(sources().find((s) => s.id === id) ?? {});
    }

    const del = path.match(/^\/api\/sources\/([^/]+)$/);
    if (del && method === "DELETE") {
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

// The NEWEST toast of a kind: toasts stack oldest-first, and several share the
// `toast-${kind}` message testid, so read the last match rather than the first.
function toastText(host: HTMLElement, kind: string): string | undefined {
  const all = host.querySelectorAll(`[data-testid="toast-${kind}"]`);
  return all[all.length - 1]?.textContent ?? undefined;
}

describe("syncToast — failure-dominates aggregation (q3a)", () => {
  const src = (status: "synced" | "unchanged" | "failed") => ({
    sourceId: "s",
    origin: "https://github.com/owner/repo",
    status,
  });

  test("any failed Source dominates a mixed result with an error count", () => {
    expect(syncToast({ sources: [src("synced"), src("failed"), src("unchanged")] })).toEqual({
      kind: "error",
      message: "Sync failed for 1 Source",
    });
  });

  test("multiple failures pluralize the error count", () => {
    expect(syncToast({ sources: [src("failed"), src("failed")] })).toEqual({
      kind: "error",
      message: "Sync failed for 2 Sources",
    });
  });

  test("no failure but some synced → a success count", () => {
    expect(syncToast({ sources: [src("synced"), src("unchanged")] })).toEqual({
      kind: "success",
      message: "Synced 1 Source",
    });
  });

  test("all unchanged → 'Up to date'", () => {
    expect(syncToast({ sources: [src("unchanged"), src("unchanged")] })).toEqual({
      kind: "success",
      message: "Up to date",
    });
  });

  test("an empty sources array → 'Up to date' (nothing to sync is not a failure)", () => {
    expect(syncToast({ sources: [] })).toEqual({ kind: "success", message: "Up to date" });
  });
});

describe("KitDeployPage — action feedback toasts (#50)", () => {
  test("the toast host renders with an aria-live region and is non-blocking", async () => {
    installStubs();
    const host = await render();
    const region = host.querySelector('[data-testid="toast-host"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    // Non-blocking: the host itself never traps pointer events.
    expect((region as HTMLElement | null)?.style.pointerEvents || "").not.toBe("auto");
  });

  test("a completed sync where all Sources are unchanged shows a success 'Up to date' toast", async () => {
    installStubs();
    const host = await render();
    await click(host.querySelector('[data-testid="kit-check-updates"]'));

    expect(calls.some((c) => c.method === "POST" && c.path === "/api/kit/sync")).toBe(true);
    expect(host.querySelector('[data-testid="toast-success"]')).not.toBeNull();
    expect(toastText(host, "success")).toContain("Up to date");
    // No error toast on a clean sync.
    expect(host.querySelector('[data-testid="toast-error"]')).toBeNull();
  });

  test("a sync result with a failed Source shows an ERROR toast (failure dominates a mixed result)", async () => {
    installStubs();
    // Mixed: one synced, one failed → the failed must dominate (q3a).
    syncResult = {
      sources: [
        { sourceId: STARTER_ID, origin: STARTER_ORIGIN, status: "synced" },
        { sourceId: GIT_ID, origin: GIT_ORIGIN, status: "failed", errorReason: "boom" },
      ],
    };
    const host = await render();
    await click(host.querySelector('[data-testid="kit-check-updates"]'));

    const error = host.querySelector('[data-testid="toast-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("1");
    // Failure dominated: no success toast despite the synced Source.
    expect(host.querySelector('[data-testid="toast-success"]')).toBeNull();
    // Error toast carries role="alert".
    const toast = host.querySelector('[data-testid="toast"]');
    expect(toast?.getAttribute("role")).toBe("alert");
  });

  test("a sync that rejects shows an error toast", async () => {
    installStubs();
    failSync = true;
    const host = await render();
    await click(host.querySelector('[data-testid="kit-check-updates"]'));

    expect(host.querySelector('[data-testid="toast-error"]')).not.toBeNull();
    expect(toastText(host, "error")).toContain("Sync failed");
  });

  test("deactivating then re-activating a Source shows the right verb in a success toast", async () => {
    installStubs();
    const host = await render();

    // Deactivate: the Source was active → "Deactivated <label>".
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    expect(host.querySelector('[data-testid="toast-success"]')).not.toBeNull();
    expect(toastText(host, "success")).toContain("Deactivated");
    expect(toastText(host, "success")).toContain("owner/repo");

    // Re-activate: now inactive → "Activated <label>". toastText reads the
    // newest toast, so it reflects the re-activation, not the earlier deactivate.
    await click(host.querySelector(`[data-testid="kit-source-toggle-${GIT_ID}"]`));
    expect(toastText(host, "success")).toContain("Activated");
  });

  test("a confirmed delete shows a 'Removed' success toast", async () => {
    installStubs();
    const host = await render();

    // Arm, then confirm the delete (two-step gate).
    await click(host.querySelector(`[data-testid="kit-source-delete-${GIT_ID}"]`));
    await click(host.querySelector(`[data-testid="kit-source-delete-confirm-${GIT_ID}"]`));

    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/sources/${GIT_ID}`)).toBe(
      true,
    );
    expect(host.querySelector('[data-testid="toast-success"]')).not.toBeNull();
    expect(toastText(host, "success")).toContain("Removed");
    expect(toastText(host, "success")).toContain("owner/repo");
  });

  test("a toast is dismissible via its explicit dismiss button (not the auto-dismiss timer)", async () => {
    installStubs();
    const host = await render();
    await click(host.querySelector('[data-testid="kit-check-updates"]'));
    expect(host.querySelector('[data-testid="toast"]')).not.toBeNull();

    const dismiss = host.querySelector('[data-testid^="toast-dismiss-"]');
    expect(dismiss).not.toBeNull();
    await click(dismiss);
    expect(host.querySelector('[data-testid="toast"]')).toBeNull();
  });
});
