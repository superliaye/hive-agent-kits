// Tiles over HTTP (ADR-0033): GET /api/tiles, POST /api/sources by Tile or by a
// Tile's pasted link, recognition by the Tile's Recipe, and whole Selection
// units read back through GET /api/kit/selection and the Overview.
//
// Hermetic: a stub GitHub serves each repository's tarball by owner/repo.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AddSourceResult,
  Catalog,
  DeploymentOverview,
  type DeployTarget,
  SelectionSnapshot,
  type Source,
  SyncRunResult,
  TileSummary,
} from "@hive/contract";
import {
  buildGzipTar,
  clearHomeEnv,
  redirectHomeEnv,
  type TarFixtureEntry,
} from "../../kit/__tests__/helpers.ts";
import type { HttpFetch } from "../../kit/sync.ts";
import { SOURCES_FILE_VERSION } from "../../sources/types.ts";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";

type Repo = { sha: string; entries: TarFixtureEntry[] };

function skillsRepo(names: readonly string[], sha = "a".repeat(40)): Repo {
  return {
    sha,
    entries: [
      { path: "top/" },
      ...names.map((name) => ({
        path: `top/skills/${name}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody\n`,
      })),
    ],
  };
}

// A capability kit with no SKILL.md anywhere: a generic Recipe recognizes it,
// the published-skills Recipe does not.
function instructionKit(): Repo {
  return {
    sha: "b".repeat(40),
    entries: [
      { path: "top/" },
      {
        path: "top/capabilities/instructions/rules.instructions.md",
        content: "---\ndescription: house rules\napplyTo: '**'\n---\nrules\n",
      },
    ],
  };
}

// Serves the GitHub commits API and codeload tarballs for `repos`, keyed by
// "owner/repo", and records which repositories were asked for.
function stubGithub(repos: Map<string, Repo>): { fetch: HttpFetch; requested: string[] } {
  const requested: string[] = [];
  const fetch: HttpFetch = async (url) => {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug =
      parsed.hostname === "api.github.com"
        ? `${segments[1]}/${segments[2]}`
        : `${segments[0]}/${segments[1]}`;
    const repo = repos.get(slug);
    if (!repo) return new Response("not found", { status: 404 });
    if (parsed.hostname === "api.github.com") {
      requested.push(`${slug} ${segments.slice(3).join("/")}`);
      return new Response(JSON.stringify({ sha: repo.sha }), { status: 200 });
    }
    return new Response(buildGzipTar(repo.entries), { status: 200 });
  };
  return { fetch, requested };
}

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  });
}

function gitLocator(repoUrl: string) {
  return {
    kind: "git",
    repoUrl,
    revision: { mode: "track", ref: "refs/heads/main" },
    subpath: ".",
  } as const;
}

async function fetchJson(server: ServerHandles, path: string, init: RequestInit = {}) {
  const res = await server.app.fetch(authed(path, init));
  return { status: res.status, body: await res.json() };
}

describe("Tiles over HTTP", () => {
  let tmpRoot: string;
  let server: ServerHandles | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hive-tiles-"));
    redirectHomeEnv(tmpRoot);
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    clearHomeEnv();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function start(repos: Map<string, Repo>) {
    const github = stubGithub(repos);
    server = await createServer({ mode: "memory", token: TOKEN, fetch: github.fetch });
    const app = server.app;
    const audit = server.audit;
    const json = async (path: string, init: RequestInit = {}) => {
      const res = await app.fetch(authed(path, init));
      return { status: res.status, body: await res.json() };
    };
    const tiles = async () => TileSummary.array().parse((await json("/api/tiles")).body);
    const catalog = async () => Catalog.parse((await json("/api/kit/catalog")).body);
    const tileSource = async (id: string) =>
      (await tiles()).find((tile) => tile.id === id)?.sourceId;
    const add = (body: unknown) =>
      json("/api/sources", { method: "POST", body: JSON.stringify(body) });
    const added = async (body: unknown) => {
      const res = await add(body);
      expect(res.status).toBe(201);
      return AddSourceResult.parse(res.body);
    };
    const selection = async () => SelectionSnapshot.parse((await json("/api/kit/selection")).body);
    const overview = async () => DeploymentOverview.parse((await json("/api/kit/overview")).body);
    const select = async (changes: { name: string; enabled: boolean; targets: DeployTarget[] }[]) =>
      json("/api/kit/selection", {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: (await selection()).revision,
          changes: changes.map(({ name, enabled, targets }) => ({
            key: { kind: "skill", name },
            enabled,
            targets,
          })),
        }),
      });
    const enabledOn = async (target: DeployTarget) =>
      (await selection()).enabled
        .filter((entry) => entry.targets.includes(target))
        .map((entry) => entry.key.name)
        .sort();
    const overviewOn = async (target: DeployTarget) =>
      (await overview()).rows
        .filter((row) => row.targets.some((t) => t.target === target && t.desired === "on"))
        .map((row) => row.key.name)
        .sort();
    return {
      json,
      tiles,
      catalog,
      tileSource,
      add,
      added,
      selection,
      overview,
      select,
      enabledOn,
      overviewOn,
      audit,
      requested: github.requested,
    };
  }

  test("GET /api/tiles lists every Tile unadded, then the Source a Tile add created", async () => {
    const api = await start(new Map([["slidevjs/slidev", skillsRepo(["slidev"])]]));
    const shelf = await api.tiles();
    expect(shelf[0]?.id).toBe("my-agent-kits");
    expect(shelf.find((tile) => tile.id === "hyperframes")?.recipe).toEqual({
      id: "published-skills",
      label: "Published skills",
      unit: "whole",
    });
    expect(shelf.every((tile) => tile.sourceId === null)).toBe(true);

    const result = await api.added({ tile: "slidev" });
    expect(result.source.label).toBe("Slidev");
    expect(result.sync.state).toBe("up_to_date");
    expect(api.requested).toEqual(["slidevjs/slidev commits/main"]);
    expect(await api.tileSource("slidev")).toBe(result.source.id);
    expect((await api.tiles()).filter((tile) => tile.sourceId !== null)).toHaveLength(1);

    const rows = await api.audit.query({ source: "sources" });
    expect(rows.map((row) => row.payload)).toEqual([
      {
        id: result.source.id,
        kind: "git",
        origin: "https://github.com/slidevjs/slidev",
        tile: "slidev",
      },
    ]);
  });

  test("a pasted link equal to a Tile's adds that Tile; an unrelated link stays pasted", async () => {
    const api = await start(
      new Map([
        ["heygen-com/hyperframes", skillsRepo(["hyperframes"])],
        ["acme/skills", skillsRepo(["acme"])],
      ]),
    );
    const tiled = await api.added({
      label: "my paste",
      locator: gitLocator("https://github.com/heygen-com/hyperframes.git"),
    });
    expect(tiled.source.label).toBe("HyperFrames");
    expect(await api.tileSource("hyperframes")).toBe(tiled.source.id);
    expect((await api.overview()).sources.find((s) => s.id === tiled.source.id)?.recipe).toEqual({
      id: "published-skills",
      label: "Published skills",
      unit: "whole",
    });

    const pasted = await api.added({
      label: "Acme skills",
      locator: gitLocator("https://github.com/acme/skills"),
    });
    expect(pasted.source.label).toBe("Acme skills");
    const claimed = (await api.tiles()).flatMap((tile) => (tile.sourceId ? [tile.sourceId] : []));
    expect(claimed).toEqual([tiled.source.id]);
    expect((await api.overview()).sources.find((s) => s.id === pasted.source.id)?.recipe).toEqual({
      id: "published-skills",
      label: "Published skills",
      unit: "pick",
    });
  });

  test("a Tile already added is a duplicate, by Tile or by its pasted link", async () => {
    const api = await start(new Map([["slidevjs/slidev", skillsRepo(["slidev"])]]));
    await api.added({ tile: "slidev" });
    expect((await api.add({ tile: "slidev" })).status).toBe(409);
    const pasted = await api.add({
      label: "again",
      locator: gitLocator("https://github.com/slidevjs/slidev"),
    });
    expect(pasted).toEqual({
      status: 409,
      body: { error: "duplicate source", origin: "https://github.com/slidevjs/slidev" },
    });
    expect((await api.add({ tile: "no-such-tile" })).status).toBe(400);
  });

  test("a Tile Source whose tree no longer matches fails Sync with the Tile reason", async () => {
    const api = await start(
      new Map([
        ["heygen-com/hyperframes", instructionKit()],
        ["acme/kit", instructionKit()],
      ]),
    );
    const tiled = await api.added({ tile: "hyperframes" });
    expect(tiled.sync).toMatchObject({
      state: "check_failed",
      errorReason: "not_recognized",
      errorDetail: "no longer matches the HyperFrames Tile: no published skills",
    });
    expect((await api.catalog()).entries).toEqual([]);

    const pasted = await api.added({
      label: "kit",
      locator: gitLocator("https://github.com/acme/kit"),
    });
    expect(pasted.sync.state).toBe("up_to_date");
    const { entries } = await api.catalog();
    expect(entries.map((entry) => entry.sourceIds)).toEqual([[pasted.source.id]]);
  });

  describe("a whole Tile Source", () => {
    const repos = () =>
      new Map([
        ["heygen-com/hyperframes", skillsRepo(["hf-cli", "hf-core"])],
        ["slidevjs/slidev", skillsRepo(["slidev", "slidev-theme"])],
      ]);

    test("selects and deselects all its Capabilities together; a pick Source does not", async () => {
      const api = await start(repos());
      const whole = await api.added({ tile: "hyperframes" });
      await api.added({ tile: "slidev" });

      const rows = (await api.overview()).rows;
      expect(rows.map((row) => [row.key.name, row.wholeSourceId])).toEqual([
        ["hf-cli", whole.source.id],
        ["hf-core", whole.source.id],
        ["slidev", null],
        ["slidev-theme", null],
      ]);

      expect(
        (await api.select([{ name: "hf-core", enabled: true, targets: ["claude"] }])).status,
      ).toBe(200);
      expect(
        (await api.select([{ name: "slidev", enabled: true, targets: ["claude"] }])).status,
      ).toBe(200);
      expect(await api.enabledOn("claude")).toEqual(["hf-cli", "hf-core", "slidev"]);
      expect(await api.overviewOn("claude")).toEqual(["hf-cli", "hf-core", "slidev"]);
      expect(await api.enabledOn("codex")).toEqual([]);

      await api.select([{ name: "hf-cli", enabled: false, targets: ["claude"] }]);
      expect(await api.enabledOn("claude")).toEqual(["slidev"]);
      expect(await api.overviewOn("claude")).toEqual(["slidev"]);
    });

    test("a re-Sync that adds a Capability shows it selected in Selection and the Overview", async () => {
      const upstream = repos();
      const api = await start(upstream);
      await api.added({ tile: "hyperframes" });
      await api.select([{ name: "hf-cli", enabled: true, targets: ["codex"] }]);

      upstream.set(
        "heygen-com/hyperframes",
        skillsRepo(["hf-cli", "hf-core", "hf-new"], "c".repeat(40)),
      );
      expect((await api.json("/api/kit/sync", { method: "POST" })).status).toBe(200);

      expect(await api.enabledOn("codex")).toEqual(["hf-cli", "hf-core", "hf-new"]);
      expect(await api.overviewOn("codex")).toEqual(["hf-cli", "hf-core", "hf-new"]);

      // hf-new was only ever enabled by the closure; deselecting still records
      // its removal, so a Deploy that installed it can remove it.
      await api.select([{ name: "hf-new", enabled: false, targets: ["codex"] }]);
      const after = await api.selection();
      expect(after.enabled).toEqual([]);
      expect(after.removalIntents.map((intent) => intent.key.name).sort()).toEqual([
        "hf-cli",
        "hf-core",
        "hf-new",
      ]);
    });

    test("turning one unit both on and off for a target is a conflict", async () => {
      const api = await start(repos());
      await api.added({ tile: "hyperframes" });
      const res = await api.select([
        { name: "hf-cli", enabled: true, targets: ["claude"] },
        { name: "hf-core", enabled: false, targets: ["claude"] },
      ]);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "selection_unit_conflict", target: "claude" });
      expect(await api.enabledOn("claude")).toEqual([]);
    });
  });
});

describe("Tiles over HTTP with a sources.json registry", () => {
  let tmpRoot: string;
  let runtimeRoot: string;
  let server: ServerHandles | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hive-tiles-file-"));
    runtimeRoot = redirectHomeEnv(tmpRoot).runtimeRoot;
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    clearHomeEnv();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeRegistry(rows: Source[]): void {
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      join(runtimeRoot, "sources.json"),
      JSON.stringify({ version: SOURCES_FILE_VERSION, revision: rows.length, sources: rows }),
    );
  }

  async function boot() {
    const booted = await createServer({ mode: "file", token: TOKEN });
    server = booted;
    const json = (path: string, init: RequestInit = {}) => fetchJson(booted, path, init);
    return {
      json,
      shelf: async () =>
        new Map(
          TileSummary.array()
            .parse((await json("/api/tiles")).body)
            .map((tile) => [tile.id, tile.sourceId]),
        ),
      add: (body: unknown) => json("/api/sources", { method: "POST", body: JSON.stringify(body) }),
    };
  }

  test("a row written with no Tile is its locator's Tile Source on the shelf and on add", async () => {
    const kit = gitLocator("https://github.com/superliaye/my-agent-kits");
    writeRegistry([
      // Inactive, so no Sync reaches the network.
      {
        id: "old-kit",
        label: "My kit",
        locator: kit,
        origin: kit.repoUrl,
        kind: "git",
        active: false,
        createdAt: 1,
        rank: 1,
      },
    ]);
    const api = await boot();

    expect((await api.shelf()).get("my-agent-kits")).toBe("old-kit");
    expect(await api.add({ tile: "my-agent-kits" })).toEqual({
      status: 409,
      body: { error: "duplicate source", origin: kit.repoUrl },
    });
    expect([...(await api.shelf()).values()].filter((id) => id !== null)).toEqual(["old-kit"]);
  });

  test("a Starter row left by an older Hive is no Tile's Source and fails Sync as missing_local_root", async () => {
    writeRegistry([
      {
        id: "starter",
        label: "local:starter",
        locator: { kind: "starter" },
        origin: "local:starter",
        kind: "local",
        active: true,
        createdAt: 0,
        rank: 0,
      },
    ]);
    const api = await boot();

    expect([...(await api.shelf()).values()].filter((id) => id !== null)).toEqual([]);
    const sync = SyncRunResult.parse((await api.json("/api/kit/sync", { method: "POST" })).body);
    expect(sync.sources).toEqual([
      {
        sourceId: "starter",
        status: "failed",
        errorReason: "missing_local_root",
        errorDetail: "local content root is unavailable",
      },
    ]);
  });
});
