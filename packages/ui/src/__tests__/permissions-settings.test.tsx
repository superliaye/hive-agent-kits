// PermissionsSettings: the per-agent run_shell allowlist. Renders the agent
// picker + read-only list, or the deny-all empty state.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PermissionsSettings } from "../components/PermissionsSettings.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

let allowlistFixture: string[] | undefined;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installStubs(): void {
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/agents") return json([{ agentId: "gated" }]);
    if (path === "/api/agents/gated") {
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
    root.render(createElement(PermissionsSettings, { apiConfig }));
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

describe("PermissionsSettings", () => {
  test("renders an agent's commandAllowlist read-only", async () => {
    installStubs();
    allowlistFixture = ["node", "git"];
    const host = await render();
    expect(host.querySelector('[data-testid="allowlist-agent-picker"]')).not.toBeNull();
    const list = host.querySelector('[data-testid="allowlist-list"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("node");
    expect(list?.textContent).toContain("git");
  });

  test("an empty allowlist renders the deny-all label", async () => {
    installStubs();
    allowlistFixture = [];
    const host = await render();
    expect(host.querySelector('[data-testid="allowlist-deny-all"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="allowlist-list"]')).toBeNull();
  });
});
