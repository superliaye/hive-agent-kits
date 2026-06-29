// Settings left-nav: the sections are Appearance · Backends —
// there is NO "Other" item, NO "Secrets" item, and NO "Permissions" item.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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

beforeAll(() => {
  setupDom();
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => json([])) as typeof fetch;
});
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

describe("Settings nav", () => {
  test("shows Appearance/Backends; no Other, no Secrets, no Permissions", async () => {
    const host = mount();
    const root = createRoot(host);
    activeRoot = root;
    await act(async () => {
      root.render(
        createElement(SettingsPage, {
          apiConfig,
          section: "backends",
          onSectionChange: () => {},
        }),
      );
    });
    await flush();

    expect(host.querySelector('[data-testid="settings-nav-appearance"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-nav-backends"]')).not.toBeNull();
    // No Other nav item.
    expect(host.querySelector('[data-testid="settings-nav-other"]')).toBeNull();
    // No Secrets nav item.
    expect(host.querySelector('[data-testid="settings-nav-secrets"]')).toBeNull();
    // No Permissions nav item.
    expect(host.querySelector('[data-testid="settings-nav-permissions"]')).toBeNull();
  });
});
