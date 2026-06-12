// BackendsSettings (Item 2 + Item 3): the health table, the delegated-update
// round-trip (POST upgrade → re-probe GET → re-render), install guidance for a
// missing CLI, and the read-only command-allowlist panel (OQ-7).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { BackendsSettings } from "../components/BackendsSettings.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

type Call = { method: string; path: string };
let calls: Call[];
let backendsSeq: unknown[][];
let upgradeResponse: unknown;
let allowlistFixture: string[] | undefined;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installStubs(): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path });

    if (method === "GET" && path === "/api/backends") {
      // Each GET pops the next probe snapshot (so update can change versions).
      const next = backendsSeq.length > 1 ? backendsSeq.shift() : backendsSeq[0];
      return json(next);
    }
    if (method === "POST" && path.endsWith("/upgrade")) {
      return json(upgradeResponse);
    }
    if (method === "GET" && path === "/api/agents") return json([{ agentId: "gated" }]);
    if (method === "GET" && path === "/api/agents/gated") {
      return json({
        agentId: "gated",
        ...(allowlistFixture !== undefined && { commandAllowlist: allowlistFixture }),
      });
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
    root.render(createElement(BackendsSettings, { apiConfig }));
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

describe("BackendsSettings", () => {
  test("renders a health table from GET /api/backends", async () => {
    installStubs();
    backendsSeq = [
      [
        { backend: "claude-code", installed: true, version: "2.0.13", reason: "ok", checkedAt: 1 },
        { backend: "codex", installed: false, version: null, reason: "not_installed", checkedAt: 1 },
      ],
    ];
    const host = await render();
    expect(host.querySelector('[data-testid="backend-row-claude-code"]')).not.toBeNull();
    expect(host.textContent).toContain("2.0.13");
    // A not_installed backend shows install guidance and NO Update button.
    expect(host.querySelector('[data-testid="backend-install-codex"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="backend-update-codex"]')).toBeNull();
    // An installed backend shows the Update button.
    expect(host.querySelector('[data-testid="backend-update-claude-code"]')).not.toBeNull();
  });

  test("Update issues POST upgrade then re-probes and re-renders the new version", async () => {
    installStubs();
    backendsSeq = [
      [{ backend: "claude-code", installed: true, version: "2.0.13", reason: "ok", checkedAt: 1 }],
      // The post-update re-probe snapshot.
      [{ backend: "claude-code", installed: true, version: "2.1.0", reason: "ok", checkedAt: 2 }],
    ];
    upgradeResponse = {
      backend: "claude-code",
      installed: true,
      version: "2.1.0",
      reason: "ok",
      checkedAt: 2,
    };
    const host = await render();
    const btn = host.querySelector('[data-testid="backend-update-claude-code"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The upgrade POST fired, followed by a GET /api/backends re-probe.
    const upgradeIdx = calls.findIndex(
      (c) => c.method === "POST" && c.path === "/api/backends/claude-code/upgrade",
    );
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    const reprobe = calls
      .slice(upgradeIdx + 1)
      .some((c) => c.method === "GET" && c.path === "/api/backends");
    expect(reprobe).toBe(true);
    expect(host.textContent).toContain("2.1.0");
  });

  test("renders an agent's commandAllowlist read-only (OQ-7)", async () => {
    installStubs();
    backendsSeq = [[]];
    allowlistFixture = ["node", "git"];
    const host = await render();
    const list = host.querySelector('[data-testid="allowlist-list"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("node");
    expect(list?.textContent).toContain("git");
  });

  test("an empty allowlist renders the deny-all label (OQ-7)", async () => {
    installStubs();
    backendsSeq = [[]];
    allowlistFixture = [];
    const host = await render();
    expect(host.querySelector('[data-testid="allowlist-deny-all"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="allowlist-list"]')).toBeNull();
  });
});
