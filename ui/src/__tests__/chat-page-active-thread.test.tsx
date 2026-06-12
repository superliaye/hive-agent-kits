// Regressions on the ACTIVE (selected) thread in the chat sidebar:
//
//   Bug 1 — renaming the active thread opened TWO InlineTitle editors at once
//   (the nav row's `renamingId === t.id` AND the header's `renamingId ===
//   activeId` are both true for the active thread), which blur-fight and close
//   instantly, so the active thread could not be renamed while a non-active one
//   could. Fix: the nav-row editor must not render for the active thread (the
//   header owns it) — exactly one editor at a time.
//
//   Bug 2 — "Mark as not read" on the currently-selected thread was reverted
//   immediately: the auto-read effect ran on every `threads` change and re-read
//   the active thread. Fix: read only on a selection CHANGE; an explicit
//   mark-unread on the active thread sticks until it is re-selected.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { ChatPage } from "../pages/ChatPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

const ROOT_ID = "root-thread";
const MGR_ID = "mgr-thread";

function summary(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "",
    agentId: "root",
    createdAt: 1,
    updatedAt: 1,
    title: null,
    titleSource: "auto",
    archivedAt: null,
    status: "idle",
    ...over,
  };
}

let threadsFixture: Array<Record<string, unknown>>;
let writeCalls: Array<{ method: string; path: string }>;

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installStubs(): void {
  writeCalls = [];
  (globalThis as { EventSource?: unknown }).EventSource = class {
    addEventListener(): void {}
    close(): void {}
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") writeCalls.push({ method, path });
    const parts = path.split("/").filter(Boolean); // ["api","threads",...]

    if (method === "GET" && path === "/api/threads") return json(threadsFixture);
    if (method === "GET" && parts.length === 3 && parts[1] === "threads") {
      const id = decodeURIComponent(parts[2] ?? "");
      const s = threadsFixture.find((t) => t.id === id) ?? summary({ id });
      return json({ ...s, messages: [] });
    }
    if (method === "GET" && path === "/api/models") return json([]);
    if (method === "GET" && path === "/api/backends") return json([]);
    if (method === "GET" && path.endsWith("/scope"))
      return json({ model: null, effort: null, workingDir: null, backend: null });
    if (method === "GET" && path.endsWith("/model-pref"))
      return json({ model: null, effort: null, backend: null });
    if (method === "GET" && parts[1] === "agents")
      return json({ agentId: "root", backend: "native", isWorker: false, config: {} });
    if (method === "PUT" && path.endsWith("/title")) {
      const id = decodeURIComponent(parts[2] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as { title: string };
      const s = threadsFixture.find((t) => t.id === id) ?? summary({ id });
      return json({ ...s, title: body.title, titleSource: "manual" });
    }
    return json({});
  }) as typeof fetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let activeRoot: Root | null = null;
const apiConfig = { baseUrl: "http://localhost", token: "test-token" };

async function render(): Promise<HTMLElement> {
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(createElement(ChatPage, { apiConfig, onNavigateToSecrets: () => {} }));
  });
  await flush();
  return host;
}

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

describe("active thread sidebar regressions", () => {
  test("Bug 1: renaming the active thread opens exactly one editor", async () => {
    threadsFixture = [
      summary({ id: ROOT_ID, agentId: "root", status: "idle" }),
      summary({ id: MGR_ID, agentId: "agent-manager", status: "idle" }),
    ];
    installStubs();
    const host = await render();

    // ROOT is auto-selected (first thread). Open rename on it the way the header
    // double-click does (renamingId := activeId).
    const headerDisplay = host.querySelector('[data-testid="inline-title-display"]');
    expect(headerDisplay).not.toBeNull();
    await act(async () => {
      headerDisplay?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await flush();

    const inputs = host.querySelectorAll('[data-testid="inline-title-input"]');
    expect(inputs.length).toBe(1);
  });

  test("Bug 2: mark-as-not-read on the active thread sticks (no auto re-read)", async () => {
    threadsFixture = [
      summary({ id: ROOT_ID, agentId: "root", status: "idle" }),
      summary({ id: MGR_ID, agentId: "agent-manager", status: "idle" }),
    ];
    installStubs();
    const host = await render();

    // ROOT is the active thread. Open its context menu and click "Mark as not read".
    const row = host.querySelector(`[data-testid="thread-${ROOT_ID}"]`);
    expect(row).not.toBeNull();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    await flush();
    const unreadItem = host.querySelector('[data-testid="thread-menu-unread"]');
    expect(unreadItem).not.toBeNull();
    const writesBefore = writeCalls.length;
    await act(async () => {
      unreadItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The active row must still show the unread dot...
    const dot = host.querySelector(`[data-testid="thread-${ROOT_ID}"] [data-testid="status-unread"]`);
    expect(dot).not.toBeNull();

    // ...and no POST /read may follow the POST /unread (the revert bug).
    const writes = writeCalls.slice(writesBefore);
    const unreadIdx = writes.findIndex((w) => w.path.endsWith("/unread"));
    expect(unreadIdx).toBeGreaterThanOrEqual(0);
    const readAfterUnread = writes
      .slice(unreadIdx + 1)
      .some((w) => w.path.endsWith("/read"));
    expect(readAfterUnread).toBe(false);
  });
});
