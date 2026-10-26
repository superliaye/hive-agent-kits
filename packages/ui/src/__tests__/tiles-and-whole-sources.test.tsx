// The Tile shelf, Recipe badges on Sources, the whole-unit note on capability
// rows, and the selection_unit_conflict message. The fetch stub is stateful: a
// POST /api/sources {tile} flips `archifyAdded`, and only the refetch after it
// returns the new Source, its row, and the Tile's sourceId.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DeploymentOverview, OverviewRow, OverviewSource, TileSummary } from "../api.ts";
import { KitDeployPage } from "../pages/KitDeployPage.tsx";
import { mount, setupDom, teardownDom } from "./happy-dom-env.ts";

const apiConfig = { baseUrl: "http://localhost", token: "test-token" };

const CAPABILITY_KIT = { id: "capability-kit", label: "Capability kit", unit: "pick" } as const;
const PUBLISHED_SKILLS = {
  id: "published-skills",
  label: "Published skills",
  unit: "pick",
} as const;
const PUBLISHED_SKILLS_WHOLE = { ...PUBLISHED_SKILLS, unit: "whole" } as const;

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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function skill(name: string, sourceId: string, wholeSourceId: string | null): OverviewRow {
  return {
    key: { kind: "skill", name },
    catalog: "deployable",
    desired: "off",
    reconciliation: "in_sync",
    lastAttempt: { state: "none" },
    applicableTargets: ["claude", "codex"],
    wholeSourceId,
    targets: (["claude", "codex"] as const).map((target) => ({
      target,
      desired: "off" as const,
      reconciliation: "in_sync" as const,
      observation: "missing" as const,
      lastAttempt: { state: "none" as const },
    })),
    variants: [
      {
        kind: "skill",
        name,
        description: `${name} skill`,
        group: "",
        deployable: true,
        shadowed: false,
        sourceIds: [sourceId],
        contentSha: Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
        catalog: "deployable",
      },
    ],
  };
}

// UI UX Pro Max's unit: a Claude-only plugin and a Codex-only bundle.
function uiproRow(kind: "plugin" | "bundle", on: boolean): OverviewRow {
  const target = kind === "plugin" ? "claude" : "codex";
  return {
    ...skill("ui-ux-pro-max", "uipro", "uipro"),
    key: { kind, name: "ui-ux-pro-max" },
    desired: on ? "on" : "off",
    applicableTargets: [target],
    targets: [
      {
        target,
        desired: on ? "on" : "off",
        reconciliation: "in_sync",
        observation: on ? "recorded_unverified" : "missing",
        lastAttempt: { state: "none" },
      },
    ],
  };
}

let calls: { method: string; path: string; body: string | undefined }[];
let archifyAdded: boolean;
let withRows: boolean;
let uipro: "absent" | "off" | "on";
let patchResponse: () => Response;

function sources(): OverviewSource[] {
  const list: OverviewSource[] = [
    {
      id: "hyperframes",
      label: "HyperFrames",
      kind: "git",
      active: true,
      rank: 1,
      recipe: PUBLISHED_SKILLS_WHOLE,
    },
    {
      id: "starter",
      label: "Starter",
      kind: "local",
      active: true,
      rank: 0,
      recipe: CAPABILITY_KIT,
    },
  ];
  if (uipro !== "absent") {
    list.push({
      id: "uipro",
      label: "UI UX Pro Max",
      kind: "git",
      active: true,
      rank: -1,
      recipe: { id: "ui-ux-pro-max-plugin-and-cli", label: "UI UX Pro Max", unit: "whole" },
    });
  }
  if (archifyAdded) {
    list.unshift({
      id: "archify",
      label: "Archify",
      kind: "git",
      active: true,
      rank: 2,
      recipe: PUBLISHED_SKILLS,
    });
  }
  return list;
}

function overview(): DeploymentOverview {
  const rows = withRows
    ? [
        skill("alpha", "starter", null),
        skill("hf-compose", "hyperframes", "hyperframes"),
        skill("hf-render", "hyperframes", "hyperframes"),
        ...(archifyAdded ? [skill("archify", "archify", null)] : []),
        ...(uipro === "absent"
          ? []
          : [uiproRow("plugin", uipro === "on"), uiproRow("bundle", uipro === "on")]),
      ]
    : [];
  return {
    sources: sources(),
    sourceRegistryRevision: 1,
    mirrors: sources().map((source) => ({
      sourceId: source.id,
      precedence: source.rank,
      identity: "abc1234",
    })),
    selectionRevision: 3,
    variants: rows.flatMap((row) => row.variants),
    rows,
    diff: { entries: [] },
    planToken: "a".repeat(64),
    activeOperation: null,
    lastOperation: null,
  };
}

function tiles(): TileSummary[] {
  return [
    {
      id: "starter",
      label: "Starter",
      description: "The capability kit bundled with Hive.",
      recipe: CAPABILITY_KIT,
      sourceId: "starter",
    },
    {
      id: "archify",
      label: "Archify",
      description: "The archify skill, deployed as its repository publishes it.",
      recipe: PUBLISHED_SKILLS,
      sourceId: archifyAdded ? "archify" : null,
    },
    {
      id: "hyperframes",
      label: "HyperFrames",
      description: "HeyGen's seven HyperFrames skills, installed together.",
      recipe: PUBLISHED_SKILLS_WHOLE,
      sourceId: "hyperframes",
    },
  ];
}

function installStubs(): void {
  calls = [];
  archifyAdded = false;
  withRows = true;
  uipro = "absent";
  patchResponse = () => json({ error: "unexpected" }, 500);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path, body });
    if (path === "/api/tiles" && method === "GET") return json(tiles());
    if (path === "/api/sources" && method === "POST") {
      archifyAdded = true;
      return json(
        {
          source: {
            id: "archify",
            label: "Archify",
            kind: "git",
            active: true,
            createdAt: 3,
            rank: 2,
          },
          sync: { state: "up_to_date", sha: "def5678", fetchedAt: 1, sourceId: "archify" },
          validation: { conformant: true, errors: [], capabilityCount: 1 },
        },
        201,
      );
    }
    if (path === "/api/kit/overview") return json(overview());
    if (path === "/api/kit/catalog") return json({ entries: [], presets: [], problems: [] });
    if (path === "/api/kit/selection" && method === "PATCH") return patchResponse();
    if (path === "/api/developer") return json({ allowRealHomeDeploy: false });
    return json({});
  }) as typeof fetch;
}

let activeRoot: Root | null = null;
beforeAll(() => setupDom());
afterAll(() => teardownDom());
afterEach(async () => {
  if (!activeRoot) return;
  const root = activeRoot;
  activeRoot = null;
  await act(async () => root.unmount());
});

async function render(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = mount();
  activeRoot = createRoot(host);
  await act(async () => {
    activeRoot?.render(
      createElement(QueryClientProvider, { client }, createElement(KitDeployPage, { apiConfig })),
    );
  });
  await flush();
  return host;
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

function byTestId(host: HTMLElement, id: string): Element | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

describe("Tile shelf", () => {
  test("lists each Tile with its Recipe, and adds one by Tile id", async () => {
    installStubs();
    const host = await render();

    expect(byTestId(host, "tile-starter")?.textContent).toContain("Starter");
    expect(byTestId(host, "tile-archify")?.textContent).toContain(
      "The archify skill, deployed as its repository publishes it.",
    );
    expect(byTestId(host, "tile-recipe-archify")?.textContent).toBe("Published skills");
    expect(byTestId(host, "tile-whole-archify")).toBeNull();
    expect(byTestId(host, "tile-whole-hyperframes")?.textContent).toBe("Installs whole");
    expect(byTestId(host, "kit-source-archify")).toBeNull();

    await click(byTestId(host, "tile-add-archify"));

    const posts = calls.filter((call) => call.method === "POST" && call.path === "/api/sources");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "null")).toEqual({ tile: "archify" });
    expect(byTestId(host, "tile-shelf")?.textContent).toContain("Added Archify — 1 capability.");
    expect(byTestId(host, "tile-added-archify")?.textContent).toBe("Added");
    expect(byTestId(host, "tile-add-archify")).toBeNull();
    expect(byTestId(host, "kit-source-archify")).not.toBeNull();
    expect(byTestId(host, "kit-row-skill-archify")).not.toBeNull();
  });

  test("a Tile whose Source is already added shows Added and offers no Add", async () => {
    installStubs();
    const host = await render();

    for (const id of ["starter", "hyperframes"]) {
      expect(byTestId(host, `tile-added-${id}`)?.textContent).toBe("Added");
      expect(byTestId(host, `tile-add-${id}`)).toBeNull();
    }
    expect(byTestId(host, "tile-add-archify")).not.toBeNull();
  });

  test("with no capabilities, the shelf is the empty state's call to action", async () => {
    installStubs();
    withRows = false;
    const host = await render();

    expect(host.querySelectorAll('[data-testid="tile-shelf"]')).toHaveLength(1);
    expect(
      host.querySelector('[data-testid="kit-empty"] [data-testid="tile-shelf"]'),
    ).not.toBeNull();
    expect(byTestId(host, "tile-add-archify")).not.toBeNull();
  });
});

describe("Whole Sources", () => {
  test("each Source shows its Recipe label, and Installs whole only when whole", async () => {
    installStubs();
    const host = await render();

    expect(byTestId(host, "kit-source-recipe-starter")?.textContent).toBe("Capability kit");
    expect(byTestId(host, "kit-source-whole-starter")).toBeNull();
    expect(byTestId(host, "kit-source-recipe-hyperframes")?.textContent).toBe("Published skills");
    expect(byTestId(host, "kit-source-whole-hyperframes")?.textContent).toBe("Installs whole");
  });

  test("rows of a whole Source name the Source they install with", async () => {
    installStubs();
    const host = await render();

    for (const name of ["hf-compose", "hf-render"]) {
      expect(byTestId(host, `kit-row-whole-skill-${name}`)?.textContent).toContain(
        "Installs with HyperFrames as one unit",
      );
    }
    expect(byTestId(host, "kit-row-whole-skill-alpha")).toBeNull();
  });

  test("a row of a unit spanning both CLIs turns the whole unit on for the targeted CLIs", async () => {
    installStubs();
    uipro = "off";
    patchResponse = () => json({ revision: 4, enabled: [], removalIntents: [] });
    const host = await render();

    await click(byTestId(host, "kit-target-codex"));
    await click(byTestId(host, "kit-row-plugin-ui-ux-pro-max"));
    await click(byTestId(host, "kit-row-bundle-ui-ux-pro-max"));

    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches.map((call) => JSON.parse(call.body ?? "null").changes)).toEqual(
      (["plugin", "bundle"] as const).map((kind) => [
        { key: { kind, name: "ui-ux-pro-max" }, enabled: true, targets: ["claude", "codex"] },
      ]),
    );
  });

  test("a row of a unit spanning both CLIs turns the whole unit off", async () => {
    installStubs();
    uipro = "on";
    patchResponse = () => json({ revision: 4, enabled: [], removalIntents: [] });
    const host = await render();

    await click(byTestId(host, "kit-row-plugin-ui-ux-pro-max"));

    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches.map((call) => JSON.parse(call.body ?? "null").changes)).toEqual([
      [
        {
          key: { kind: "plugin", name: "ui-ux-pro-max" },
          enabled: false,
          targets: ["claude", "codex"],
        },
      ],
    ]);
  });

  test("a selection_unit_conflict names the whole Source and the target", async () => {
    installStubs();
    patchResponse = () =>
      json({ error: "selection_unit_conflict", sourceId: "hyperframes", target: "codex" }, 409);
    const host = await render();

    await click(byTestId(host, "kit-row-skill-hf-compose"));

    expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    const banner = byTestId(host, "kit-selection-error")?.textContent ?? "";
    expect(banner).toContain("HyperFrames installs whole");
    expect(banner).toContain("for Codex");
    expect(banner).not.toContain("Could not update Selection");
  });
});
