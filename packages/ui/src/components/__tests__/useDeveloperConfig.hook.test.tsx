// Hook-level coverage for useDeveloperConfig — the data seam shared by
// DeveloperSettings (the toggle) and KitDeployPage (the armed banner). Proves the
// durable contract both components depend on: a failing PUT rolls the slice back
// to its pre-write value and surfaces the error; a successful PUT persists it.
// (The optimistic-then-live propagation across surfaces is proven positively by
// the kit-deploy cross-surface regression test.)

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mount, setupDom, teardownDom } from "../../__tests__/happy-dom-env.ts";
import type { ApiConfig } from "../../api.ts";
import { type UseDeveloperConfig, useDeveloperConfig } from "../useDeveloperConfig.ts";

const apiConfig: ApiConfig = { baseUrl: "http://localhost", token: "test-token" };

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

// Bridge the hook value out of the tree so the test can call its setter and read
// derived state between act() flushes.
function Probe({ onValue }: { onValue: (v: UseDeveloperConfig) => void }): null {
  const value = useDeveloperConfig(apiConfig);
  useEffect(() => {
    onValue(value);
  });
  return null;
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

async function renderHook(onValue: (v: UseDeveloperConfig) => void): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(Probe, { onValue })),
    );
  });
  await flush();
}

describe("useDeveloperConfig", () => {
  test("rolls back to off and surfaces a save error when the PUT fails", async () => {
    // GET reads off; PUT 500s — exercises rollback + error surfacing.
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/developer")) {
        if (init?.method === "PUT") return new Response("nope", { status: 500 });
        return json({ allowRealHomeDeploy: false });
      }
      return json({});
    }) as typeof fetch;

    let latest: UseDeveloperConfig | undefined;
    await renderHook((v) => {
      latest = v;
    });

    // Loaded, off, no error.
    expect(latest?.loaded).toBe(true);
    expect(latest?.armed).toBe(false);
    expect(latest?.saveError).toBeNull();

    // Fire the write and let the failing PUT settle: rolled back to off, error shown.
    await act(async () => {
      latest?.setAllowRealHomeDeploy(true);
    });
    await flush();

    expect(latest?.armed).toBe(false);
    expect(latest?.saveError).not.toBeNull();
  });

  test("a successful write persists armed without rollback", async () => {
    let stored = { allowRealHomeDeploy: false };
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/developer")) {
        if (init?.method === "PUT") {
          stored = JSON.parse(String(init.body)) as typeof stored;
          return json(stored);
        }
        return json(stored);
      }
      return json({});
    }) as typeof fetch;

    let latest: UseDeveloperConfig | undefined;
    await renderHook((v) => {
      latest = v;
    });
    expect(latest?.armed).toBe(false);

    await act(async () => {
      latest?.setAllowRealHomeDeploy(true);
    });
    await flush();

    expect(latest?.armed).toBe(true);
    expect(latest?.saveError).toBeNull();
    expect(stored.allowRealHomeDeploy).toBe(true);
  });
});
