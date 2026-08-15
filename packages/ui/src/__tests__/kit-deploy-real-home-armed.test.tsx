// Persistent armed-state indicator at the Deploy surface: when the developer
// escape hatch `allowRealHomeDeploy` is ON, KitDeployPage shows a warning banner
// (mirroring the DeveloperSettings armed banner) so a user about to Deploy sees
// that deploys write the REAL home; when OFF the banner is absent.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Catalog, KitState, VerifyReport } from "../api.ts";
import { DeveloperSettings } from "../components/DeveloperSettings.tsx";
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

function catalog(): Catalog {
  return { entries: [], presets: [], problems: [] };
}

function kitState(): KitState {
  return {
    sync: [],
    ledger: {
      kitVersion: "1.0.0",
      agents: ["claude"],
      skills: [],
      agentDefs: [],
      instructions: [],
      plugins: [],
      bundles: [],
    },
  };
}

// Mutable server-side developer state: GET reads it, PUT (from DeveloperSettings)
// persists it — so the cross-surface test exercises a real round-trip.
let realHomeOn: boolean;
// When true, GET /api/developer returns a 500 — exercises the fail-closed path.
let developerErrors: boolean;

function installStubs(): void {
  developerErrors = false;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/kit/overview")
      return json(overviewFromLegacy({ catalog: catalog(), state: kitState(), sources: [] }));
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources") return json([]);
    if (path === "/api/developer") {
      if (method === "PUT") {
        realHomeOn = (JSON.parse(String(init?.body)) as { allowRealHomeDeploy: boolean })
          .allowRealHomeDeploy;
        return json({ allowRealHomeDeploy: realHomeOn });
      }
      if (developerErrors) return json({ error: "boom" }, 500);
      return json({ allowRealHomeDeploy: realHomeOn });
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

describe("KitDeployPage — real-home armed indicator", () => {
  test("renders the armed banner when allowRealHomeDeploy is true", async () => {
    realHomeOn = true;
    installStubs();
    const host = await render();
    const banner = host.querySelector('[data-testid="deploy-real-home-armed"]');
    expect(banner).not.toBeNull();
    expect(banner?.classList.contains("banner-warn")).toBe(true);
    // Assertive announcement (present on first render, not change-driven) + a recovery
    // pointer to where the escape hatch is disarmed.
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent ?? "").toContain("Settings → Developer");
  });

  test("omits the armed banner when allowRealHomeDeploy is false", async () => {
    realHomeOn = false;
    installStubs();
    const host = await render();
    expect(host.querySelector('[data-testid="deploy-real-home-armed"]')).toBeNull();
  });

  // Fail-closed (review-committee finding): a failed GET /api/developer must NOT
  // leave the banner showing-or-flickering; the hatch reads not-armed on error.
  test("hides the armed banner when the developer query errors (fail closed)", async () => {
    realHomeOn = true; // server WOULD say armed…
    installStubs();
    developerErrors = true; // …but the read fails
    const host = await render();
    expect(host.querySelector('[data-testid="deploy-real-home-armed"]')).toBeNull();
  });

  // Cross-surface coherence (review-committee high finding): KitDeployPage stays
  // permanently mounted while the toggle lives on another surface. Arming it in
  // DeveloperSettings must refresh the Deploy banner live — proven here by mounting
  // BOTH under one shared QueryClient (mirroring the real App) and toggling.
  test("arming the toggle in DeveloperSettings makes the Deploy banner appear live", async () => {
    realHomeOn = false;
    installStubs();
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
          createElement(DeveloperSettings, { apiConfig }),
        ),
      );
    });
    await flush();

    // Banner absent at the start (hatch off).
    expect(host.querySelector('[data-testid="deploy-real-home-armed"]')).toBeNull();

    // Toggle the developer setting ON via its own control.
    const toggle = host.querySelector<HTMLInputElement>(
      '[data-testid="developer-allow-real-home-deploy"]',
    );
    if (!toggle) throw new Error("developer toggle not found");
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The invalidation propagated to KitDeployPage's ["developer"] query and the
    // persistent banner now shows — without remounting the Deploy page.
    expect(host.querySelector('[data-testid="deploy-real-home-armed"]')).not.toBeNull();
  });
});
