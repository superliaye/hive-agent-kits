import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source, VerifyReport } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
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

function skillEntry(name: string): CapabilityEntry {
  return {
    kind: "skill",
    name,
    description: `${name} skill`,
    group: "",
    deployable: true,
    shadowed: false,
    sourceIds: [GIT_ID],
    contentSha: name === "alpha" ? "a".repeat(64) : "b".repeat(64),
  };
}

function catalog(): Catalog {
  return {
    entries: [skillEntry("alpha"), skillEntry("beta")],
    presets: [
      {
        name: "starter",
        description: "starter preset",
        defaultAgents: ["claude"],
        capabilities: {
          instructions: [],
          skills: ["alpha"],
          agents: [],
          plugins: [],
          bundles: [],
        },
      },
    ],
    problems: [],
  };
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
    ],
    ledger: null,
  };
}

function installStubs(): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/kit/catalog") return json(catalog());
    if (path === "/api/kit/state") return json(kitState());
    if (path === "/api/kit/verify") return json(emptyVerify);
    if (path === "/api/sources" && method === "GET") {
      return json([
        {
          id: GIT_ID,
          origin: GIT_ORIGIN,
          kind: "git",
          active: true,
          createdAt: 1,
          rank: 0,
        } satisfies Source,
      ]);
    }
    if (path === "/api/kit/diff" && method === "POST") return json({ entries: [] });
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

describe("KitDeployPage - additive Preset review copy", () => {
  test("applying a Preset keeps manual selections and surfaces leftover Selection copy", async () => {
    installStubs();
    const host = await render();

    await click(host.querySelector('[data-testid="kit-row-skill-beta"]'));
    await click(host.querySelector(".kit-preset"));

    expect(host.querySelector('[data-testid="kit-row-skill-alpha"]')?.className).toContain(
      "selected",
    );
    expect(host.querySelector('[data-testid="kit-row-skill-beta"]')?.className).toContain(
      "selected",
    );
    const note = host.querySelector('[data-testid="kit-preset-note"]')?.textContent ?? "";
    expect(note).toContain("Presets add to the current Selection");
    expect(note).toContain("1 selected outside active Presets");
  });
});
