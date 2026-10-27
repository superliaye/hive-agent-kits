import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityEntry, Catalog, KitState, Source } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";
import { overviewFromLegacy } from "./kit-overview-test-helpers.ts";

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

function entry(over: Partial<CapabilityEntry> & Pick<CapabilityEntry, "name">): CapabilityEntry {
  return {
    kind: "skill",
    description: "desc",
    group: "",
    deployable: true,
    shadowed: false,
    sourceIds: ["src-a"],
    contentSha: "a".repeat(64),
    ...over,
  };
}

function source(id: string, label: string, rank: number): Source {
  return {
    id,
    label,
    locator: {
      kind: "git",
      repoUrl: `https://example.invalid/${id}`,
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    },
    origin: `https://example.invalid/${id}`,
    kind: "git",
    active: true,
    createdAt: rank,
    rank,
  };
}

const entries: CapabilityEntry[] = [
  entry({ name: "pdf-tools", description: "Read and write PDF files" }),
  entry({
    name: "git-helper",
    description: "Commit and rebase helpers",
    sourceIds: ["src-b"],
    contentSha: "b".repeat(64),
  }),
  entry({ name: "reviewer", kind: "agent", description: "Reviews diffs" }),
  entry({ name: "whole-one", sourceIds: ["src-w"], contentSha: "c".repeat(64) }),
];
const sources = [
  source("src-a", "acme/alpha", 0),
  source("src-b", "acme/beta", 1),
  source("src-w", "acme/whole", 2),
];

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

async function render(active = true): Promise<HTMLElement> {
  const catalog: Catalog = { entries, presets: [], problems: [] };
  const state: KitState = {
    sync: sources.map((s) => ({ state: "up_to_date", sha: "abc", fetchedAt: 1, sourceId: s.id })),
    ledger: null,
  };
  const overview = overviewFromLegacy({ catalog, state, sources });
  for (const row of overview.rows) {
    if (row.key.name === "whole-one") row.wholeSourceId = "src-w";
  }
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/kit/overview") return json(overview);
    if (path === "/api/kit/catalog") return json(catalog);
    if (path === "/api/sources") return json(sources);
    if (path === "/api/tiles") return json([]);
    return json({});
  }) as typeof fetch;

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(KitDeployPage, { apiConfig, active }),
      ),
    );
  });
  await flush();
  return host;
}

function byTestId(host: HTMLElement, id: string): Element | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

function searchInput(host: HTMLElement): HTMLInputElement {
  const input = byTestId(host, "kit-search");
  if (!(input instanceof HTMLInputElement)) throw new Error("search input missing");
  return input;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function press(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await flush();
  return event;
}

function visibleRows(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid^="kit-row-"][role="switch"]')].map(
    (row) => row.getAttribute("data-testid") ?? "",
  );
}

describe("KitDeployPage — capability search", () => {
  test("renders the search box with a visible shortcut hint", async () => {
    const host = await render();
    const input = searchInput(host);
    expect(input.type).toBe("search");
    expect(input.getAttribute("aria-label")).toBe("Search capabilities");
    expect(["⌘F", "Ctrl+F"]).toContain(host.querySelector(".kit-search kbd")?.textContent ?? "");
  });

  test("filters rows by name, description, and Source label", async () => {
    const host = await render();
    const input = searchInput(host);

    await type(input, "pdf");
    expect(visibleRows(host)).toEqual(["kit-row-skill-pdf-tools"]);

    await type(input, "REBASE");
    expect(visibleRows(host)).toEqual(["kit-row-skill-git-helper"]);

    await type(input, "acme/beta");
    expect(visibleRows(host)).toEqual(["kit-row-skill-git-helper"]);

    await type(input, "");
    expect(visibleRows(host).length).toBe(3);
  });

  test("matches every term (AND) and the kind label", async () => {
    const host = await render();
    const input = searchInput(host);

    await type(input, "acme/alpha reviews");
    expect(visibleRows(host)).toEqual(["kit-row-agent-reviewer"]);

    await type(input, "skills alpha");
    expect(visibleRows(host)).toEqual(["kit-row-skill-pdf-tools"]);
  });

  test("updates the section count and hides empty sections", async () => {
    const host = await render();
    const skills = (): Element | null => byTestId(host, "kit-kind-skill");
    expect(skills()?.querySelector(".kit-kind-count")?.textContent).toBe("2");

    await type(searchInput(host), "pdf");
    expect(skills()?.querySelector(".kit-kind-count")?.textContent).toBe("1");
    expect(byTestId(host, "kit-kind-agent")).toBeNull();
    expect(byTestId(host, "kit-kind-whole")).toBeNull();
  });

  test("a Whole Source matches by a member name and shows whole", async () => {
    const host = await render();
    await type(searchInput(host), "whole-one");
    expect(byTestId(host, "kit-unit-src-w")).not.toBeNull();
    expect(byTestId(host, "kit-unit-member-skill-whole-one")).not.toBeNull();
    expect(visibleRows(host)).toEqual([]);
  });

  test("Ctrl+F and Meta+F focus the search box and suppress the browser find", async () => {
    const host = await render();
    const input = searchInput(host);

    const ctrl = await press(window, { key: "f", ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    input.blur();
    const meta = await press(window, { key: "F", metaKey: true });
    expect(meta.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    input.blur();
    const shifted = await press(window, { key: "f", ctrlKey: true, shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  test("Ctrl+F does nothing while the page is not active", async () => {
    const host = await render(false);
    const event = await press(window, { key: "f", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(searchInput(host));
  });

  test("Escape clears the query, then blurs the box", async () => {
    const host = await render();
    const input = searchInput(host);
    await press(window, { key: "f", ctrlKey: true });
    await type(input, "pdf");

    await press(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(visibleRows(host).length).toBe(3);
    expect(document.activeElement).toBe(input);

    await press(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });

  test("shows a no-match state whose Clear button restores the list", async () => {
    const host = await render();
    const input = searchInput(host);
    expect(byTestId(host, "kit-search-empty")).toBeNull();

    await type(input, "pdf nothing-here");
    const empty = byTestId(host, "kit-search-empty");
    expect(empty?.textContent).toContain("No capabilities match “pdf nothing-here”.");
    expect(visibleRows(host)).toEqual([]);

    await act(async () => {
      byTestId(host, "kit-search-clear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(input.value).toBe("");
    expect(byTestId(host, "kit-search-empty")).toBeNull();
    expect(visibleRows(host).length).toBe(3);
    expect(document.activeElement).toBe(input);
  });
});
