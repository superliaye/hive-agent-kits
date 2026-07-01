import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, Source } from "@hive/contract";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";
const FIXTURE_IDS = ["fixture-alpha", "fixture-beta", "fixture-gamma"] as const;

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
      authorization: `Bearer ${TOKEN}`,
    },
  });
}

async function getSources(server: ServerHandles): Promise<Source[]> {
  const res = await server.app.fetch(authed("/api/sources"));
  expect(res.status).toBe(200);
  return (await res.json()) as Source[];
}

async function waitForCatalog(server: ServerHandles): Promise<Catalog> {
  let last: Catalog | null = null;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const catalog = server.kit.catalog();
    last = catalog;
    if (catalog.entries.some((entry) => entry.sourceIds.includes("fixture-gamma"))) {
      return catalog;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (last) return last;
  throw new Error("catalog was not readable");
}

type FileSnapshot =
  | { exists: false }
  | { exists: true; kind: "file"; content: string }
  | {
      exists: true;
      kind: "other";
    };

function snapshotPath(path: string): FileSnapshot {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  if (stat.isFile()) return { exists: true, kind: "file", content: readFileSync(path, "utf8") };
  return { exists: true, kind: "other" };
}

async function rmEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Windows can hold the file-mode trace log briefly after runtime.dispose().
  }
}

describe("dev fixture Sources mode", () => {
  let fixtureRuntime: string;
  let normalRuntime: string;
  let fetchCalls: number;

  beforeEach(() => {
    fixtureRuntime = mkdtempSync(join(tmpdir(), "hive-fixture-runtime-"));
    normalRuntime = mkdtempSync(join(tmpdir(), "hive-normal-runtime-"));
    fetchCalls = 0;
    delete process.env.HIVE_PACKAGED;
    delete process.env.HIVE_CLAUDE_HOME;
    delete process.env.HIVE_CODEX_HOME;
    delete process.env.HIVE_AGENTS_HOME;
    delete process.env.HIVE_LEDGER_PATH;
  });

  afterEach(async () => {
    delete process.env.HIVE_RUNTIME_ROOT;
    delete process.env.HIVE_DEV_FIXTURE_SOURCES;
    delete process.env.HIVE_FIXTURE_SOURCES_ROOT;
    await rmEventually(fixtureRuntime);
    await rmEventually(normalRuntime);
  });

  async function fixtureServer(): Promise<ServerHandles> {
    process.env.HIVE_RUNTIME_ROOT = fixtureRuntime;
    return createServer({
      mode: "file",
      token: TOKEN,
      fixtureSources: true,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fixture Sources must not fetch");
      },
    });
  }

  test("seeds offline local Sources, syncs/catalogs all kinds, and preserves audit/delete-sticks", async () => {
    let server = await fixtureServer();
    try {
      const sources = await getSources(server);
      expect(sources.map((source) => source.id)).toEqual([
        "starter",
        "fixture-alpha",
        "fixture-beta",
        "fixture-gamma",
      ]);
      expect(sources.every((source) => source.kind === "local")).toBe(true);
      expect(sources.find((source) => source.id === "fixture-gamma")?.rank).toBeGreaterThan(
        sources.find((source) => source.id === "fixture-alpha")?.rank ?? -1,
      );

      const catalog = await waitForCatalog(server);
      expect(fetchCalls).toBe(0);
      expect(catalog.problems).toEqual([]);
      for (const kind of ["instruction", "skill", "agent", "plugin", "bundle"]) {
        expect(
          catalog.entries.filter((entry) => entry.kind === kind).length,
        ).toBeGreaterThanOrEqual(6);
      }
      expect(catalog.presets.map((preset) => preset.name)).toEqual(
        expect.arrayContaining(["alpha-quick", "beta-quick", "gamma-quick"]),
      );

      const merged = catalog.entries.filter(
        (entry) => entry.kind === "skill" && entry.name === "merged-duplicate",
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]?.sourceIds).toEqual(
        expect.arrayContaining(["fixture-alpha", "fixture-beta"]),
      );
      expect(merged[0]?.shadowed).toBe(false);
      expect(merged[0]?.deployable).toBe(true);

      const collision = catalog.entries.filter(
        (entry) => entry.kind === "skill" && entry.name === "priority-tool",
      );
      expect(collision).toHaveLength(2);
      const winner = collision.find((entry) => entry.deployable);
      const shadow = collision.find((entry) => entry.shadowed);
      expect(winner?.sourceIds[0]).toBe("fixture-gamma");
      expect(shadow?.sourceIds[0]).toBe("fixture-alpha");
      expect(shadow?.deployable).toBe(false);
      expect(shadow?.shadowedBy).toBe("fixture-gamma");

      const state = server.kit.state();
      for (const id of FIXTURE_IDS) {
        const sync = state.sync.find((entry) => entry.sourceId === id);
        expect(sync?.state).toBe("local");
        expect(sync?.sha).toBeNull();
      }

      expect(await server.audit.query({ source: "sources" })).toEqual([]);

      const del = await server.app.fetch(authed("/api/sources/fixture-beta", { method: "DELETE" }));
      expect(del.status).toBe(204);
      expect((await getSources(server)).some((source) => source.id === "fixture-beta")).toBe(false);
      const auditRows = await server.audit.query({ source: "sources" });
      expect(auditRows.some((row) => row.event_type === "source.added")).toBe(false);
    } finally {
      await server.dispose();
    }

    server = await fixtureServer();
    try {
      const sources = await getSources(server);
      expect(sources.some((source) => source.id === "fixture-beta")).toBe(false);
      expect(sources.some((source) => source.id === "fixture-alpha")).toBe(true);
      expect(sources.some((source) => source.id === "fixture-gamma")).toBe(true);
    } finally {
      await server.dispose();
    }
  });

  test("fixture runtime is isolated from normal runtime and deploy stays in the dev sandbox", async () => {
    let server = await fixtureServer();
    try {
      await waitForCatalog(server);
    } finally {
      await server.dispose();
    }

    process.env.HIVE_RUNTIME_ROOT = normalRuntime;
    delete process.env.HIVE_DEV_FIXTURE_SOURCES;
    server = await createServer({
      mode: "file",
      token: TOKEN,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("normal local Starter must not fetch");
      },
    });
    try {
      const sources = await getSources(server);
      expect(sources.map((source) => source.id)).toEqual(["starter"]);
      expect(sources.some((source) => FIXTURE_IDS.some((id) => id === source.id))).toBe(false);
    } finally {
      await server.dispose();
    }

    server = await fixtureServer();
    try {
      await waitForCatalog(server);
      await server.config.set("developer", { allowRealHomeDeploy: true });
      const realPaths = [
        join(homedir(), ".claude", "skills", "alpha-focus", "SKILL.md"),
        join(homedir(), ".agents", "skills", "alpha-focus", "SKILL.md"),
        join(homedir(), ".claude", "agents", "alpha-planner.md"),
        join(homedir(), ".claude", "CLAUDE.md"),
        join(homedir(), ".codex", "AGENTS.md"),
      ];
      const before = realPaths.map(snapshotPath);
      const deploy = await server.app.fetch(
        authed("/api/kit/deploy", {
          method: "POST",
          body: JSON.stringify({
            presets: [],
            add: {
              instructions: ["alpha-code"],
              skills: ["alpha-focus", "priority-tool"],
              agents: ["alpha-planner"],
              plugins: [],
              bundles: [],
            },
            remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
            targets: ["claude", "codex"],
          }),
        }),
      );
      expect(deploy.status).toBe(200);
      expect(
        existsSync(join(fixtureRuntime, "homes", ".claude", "skills", "alpha-focus", "SKILL.md")),
      ).toBe(true);
      expect(
        existsSync(join(fixtureRuntime, "homes", ".agents", "skills", "alpha-focus", "SKILL.md")),
      ).toBe(true);
      expect(
        existsSync(join(fixtureRuntime, "homes", ".claude", "agents", "alpha-planner.md")),
      ).toBe(true);
      expect(realPaths.map(snapshotPath)).toEqual(before);
    } finally {
      await server.dispose();
    }
  });
});
