// Kit module orchestration (#30): per-Source sync over the injected
// SourceRegistry, per-Source freshness in state(), the retired single-kit
// identity in the deploy audit, and the launch-sync ordering invariant.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SourceRegistry, SourceRegistryLive } from "../../../sources/effect/sources-live.ts";
import { buildGzipTar, clearHomeEnv, redirectHomeEnv } from "../../__tests__/helpers.ts";
import { mirrorExists } from "../../mirror.ts";
import type { HttpFetch } from "../../sync.ts";
import { failSafeDeployTargets } from "../../targets.ts";
import type { DeployAuditEvents } from "../../types.ts";
import { Kit, KitLive } from "../kit-live.ts";

const SHA = "a".repeat(40);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-live-"));
  redirectHomeEnv(tmpRoot);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function tarball(sha: string, skillName: string): Response {
  const top = `repo-${sha.slice(0, 7)}`;
  return new Response(
    buildGzipTar([
      { path: `${top}/` },
      {
        path: `${top}/capabilities/skills/${skillName}/SKILL.md`,
        content: `---\ndescription: ${skillName}\n---\nbody`,
      },
    ]),
    { status: 200 },
  );
}

// Every Source ships the same skill `foo` (used for collision + single-Source
// cases).
function okFetch(sha: string): HttpFetch {
  return async (url) =>
    url.includes("api.github.com")
      ? new Response(JSON.stringify({ sha }), { status: 200 })
      : tarball(sha, "foo");
}

// Each Source ships a distinct skill named after its owner-path segment, so a
// multi-Source deploy has no cross-Source CapabilityKey collision.
function distinctFetch(sha: string): HttpFetch {
  return async (url) => {
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ sha }), { status: 200 });
    }
    // codeload URL: .../owner/<repo>/tar.gz/<sha>
    const m = /codeload\.github\.com\/owner\/([^/]+)\//.exec(url);
    return tarball(sha, `skill-${m?.[1] ?? "x"}`);
  };
}

// A KitLive over a memory SourceRegistry seeded with `origins` (all active).
function kitOver(origins: string[], fetchImpl: HttpFetch) {
  const sourcesLayer = SourceRegistryLive({
    mode: "memory",
    initial: origins.map((origin, i) => ({
      id: `src-${i}`,
      origin,
      kind: "git" as const,
      active: true,
      createdAt: i,
      rank: i,
    })),
  });
  // Merge so both Kit (with the shared registry provided) and SourceRegistry are
  // resolvable off the runtime — exactly the server's composition.
  const rootLayer = Layer.merge(
    KitLive({ fetch: fetchImpl }).pipe(Layer.provide(sourcesLayer)),
    sourcesLayer,
  );
  const rt = ManagedRuntime.make(rootLayer);
  const registry = rt.runSync(SourceRegistry);
  const kit = rt.runSync(Kit);
  return { kit, registry, rt };
}

describe("Kit.sync — per-Source (#30)", () => {
  test("two active Sources sync into two distinct mirrors; state() has one entry each", async () => {
    const { kit, registry, rt } = kitOver(
      ["https://github.com/owner/a", "https://github.com/owner/b"],
      okFetch(SHA),
    );
    const result = await Effect.runPromise(kit.sync());
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((s) => s.status === "synced")).toBe(true);

    const targets = failSafeDeployTargets();
    for (const s of registry.currentSources()) {
      expect(mirrorExists(targets.mirrorRoot(s.id))).toBe(true);
    }

    const state = kit.state();
    expect(state.sync).toHaveLength(2);
    expect(state.sync.map((s) => s.sourceId).sort()).toEqual(["src-0", "src-1"]);
    expect(state.sync.every((s) => s.state === "up_to_date")).toBe(true);
    rt.dispose();
  });

  test("one Source offline → it reports failed, the other syncs; freshness isolated", async () => {
    // A offline, B ok.
    const fetchImpl: HttpFetch = async (url) => {
      if (url.includes("/owner/a/")) throw new Error("ENOTFOUND");
      return url.includes("api.github.com")
        ? new Response(JSON.stringify({ sha: SHA }), { status: 200 })
        : tarball(SHA, "foo");
    };
    const { kit, rt } = kitOver(
      ["https://github.com/owner/a", "https://github.com/owner/b"],
      fetchImpl,
    );
    const result = await Effect.runPromise(kit.sync());
    const a = result.sources.find((s) => s.sourceId === "src-0");
    const b = result.sources.find((s) => s.sourceId === "src-1");
    expect(a?.status).toBe("failed");
    expect(b?.status).toBe("synced");

    const state = kit.state();
    const aState = state.sync.find((s) => s.sourceId === "src-0");
    const bState = state.sync.find((s) => s.sourceId === "src-1");
    expect(aState?.state).not.toBe("up_to_date");
    expect(bState?.state).toBe("up_to_date");
    rt.dispose();
  });

  test("deploy audit payload is refs-only with kitSha:null for N==1 and N>1", async () => {
    // N==1
    const single = kitOver(["https://github.com/owner/a"], okFetch(SHA));
    await Effect.runPromise(single.kit.sync());
    const events1: DeployAuditEvents["deploy.applied"][] = [];
    single.kit.events.on("deploy.applied", (e) => {
      events1.push(e);
    });
    await Effect.runPromise(
      single.kit.deploy({
        presets: [],
        add: { instructions: [], skills: ["foo"], agents: [], plugins: [], bundles: [] },
        remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
        targets: ["claude"],
      }),
    );
    expect(events1).toHaveLength(1);
    expect(events1[0]?.kitSha).toBeNull();
    single.rt.dispose();

    // N>1 (fresh home so mirrors don't clash). Distinct skills per Source so the
    // union-resolver deploys both with no cross-Source collision.
    clearHomeEnv();
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = mkdtempSync(join(tmpdir(), "kit-live-"));
    redirectHomeEnv(tmpRoot);
    const multi = kitOver(
      ["https://github.com/owner/a", "https://github.com/owner/b"],
      distinctFetch(SHA),
    );
    await Effect.runPromise(multi.kit.sync());
    const events2: DeployAuditEvents["deploy.applied"][] = [];
    multi.kit.events.on("deploy.applied", (e) => {
      events2.push(e);
    });
    const result = await Effect.runPromise(
      multi.kit.deploy({
        presets: [],
        add: {
          instructions: [],
          skills: ["skill-a", "skill-b"],
          agents: [],
          plugins: [],
          bundles: [],
        },
        remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
        targets: ["claude"],
      }),
    );
    expect(result.perKind.find((k) => k.kind === "skill")?.applied.sort()).toEqual([
      "skill-a",
      "skill-b",
    ]);
    expect(events2).toHaveLength(1);
    expect(events2[0]?.kitSha).toBeNull();
    multi.rt.dispose();
  });
});

describe("Kit launch-sync ordering (#32, file mode — local Starter seed)", () => {
  // Point the Starter content root at the real in-repo package (hermetic, no env
  // leak between tests).
  const STARTER_PKG = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "..",
    "agent-kit-starter-template",
  );

  test("a fresh file-mode boot seeds the LOCAL Starter and a no-fetch sync copies it into a Mirror", async () => {
    // No sources.json under the Hive home → openStore seeds the local Starter
    // during the registry acquire (forced first because Kit depends on it), then
    // the sync branches on kind:'local' and COPIES the bundle (never fetches).
    process.env.HIVE_STARTER_ROOT = STARTER_PKG;
    const sourcesPath = join(tmpRoot, "runtime", "sources.json");
    expect(existsSync(sourcesPath)).toBe(false);
    // A fetch that would throw if ever called — proves the local path makes no
    // network call.
    const noFetch: HttpFetch = async () => {
      throw new Error("local Starter must not fetch");
    };
    const sourcesLayer = SourceRegistryLive({ mode: "file", path: sourcesPath });
    const rt = ManagedRuntime.make(
      Layer.merge(KitLive({ fetch: noFetch }).pipe(Layer.provide(sourcesLayer)), sourcesLayer),
    );
    const registry = rt.runSync(SourceRegistry);
    const kit = rt.runSync(Kit);

    const seeded = registry.currentSources();
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.id).toBe("starter");
    expect(seeded[0]?.kind).toBe("local");

    const result = await Effect.runPromise(kit.sync());
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.status).toBe("synced");

    const mirror = failSafeDeployTargets().mirrorRoot("starter");
    expect(mirrorExists(mirror)).toBe(true);
    // The bundled Starter skill landed; NO provenance file was written.
    expect(
      existsSync(join(mirror, "capabilities", "skills", "summarize-changes", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(mirror, ".hive-mirror.json"))).toBe(false);
    expect(existsSync(join(mirror, "presets", "starter.yaml"))).toBe(true);

    // Catalog lists the Starter's capabilities; sync-status is "local".
    const cat = kit.catalog();
    expect(cat.entries.some((e) => e.kind === "skill" && e.name === "summarize-changes")).toBe(
      true,
    );
    expect(cat.presets.some((p) => p.name === "starter")).toBe(true);
    expect(cat.problems).toEqual([]);

    const state = kit.state();
    expect(state.sync).toHaveLength(1);
    expect(state.sync[0]?.state).toBe("local");
    expect(state.sync[0]?.sha).toBeNull();
    expect(state.sync[0]?.fetchedAt).toBeNull();

    delete process.env.HIVE_STARTER_ROOT;
    rt.dispose();
  });
});

describe("Kit ↔ SourceRegistry shared store (#30 wiring invariant)", () => {
  test("a registry mutation is visible to Kit's read model (one shared store)", async () => {
    // The server wires KitLive.pipe(Layer.provide(sourcesLayer)) + merges the same
    // sourcesLayer, so Kit and the Sources routes resolve ONE store (Effect
    // memoizes a Layer by reference). A route-side add() must be visible through
    // kit.state()/catalog() — guard against a refactor that splits the store.
    const sourcesLayer = SourceRegistryLive({ mode: "memory" });
    const rt = ManagedRuntime.make(
      Layer.merge(KitLive({ fetch: okFetch(SHA) }).pipe(Layer.provide(sourcesLayer)), sourcesLayer),
    );
    const registry = rt.runSync(SourceRegistry);
    const kit = rt.runSync(Kit);

    expect(kit.state().sync).toHaveLength(0);
    await Effect.runPromise(
      registry.add({
        label: "added-at-runtime",
        locator: {
          kind: "git",
          repoUrl: "https://github.com/owner/added-at-runtime",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
      }),
    );
    // Visible to Kit without any re-wiring — proves the single shared store.
    expect(kit.state().sync).toHaveLength(1);
    expect(kit.state().sync[0]?.origin).toBe("https://github.com/owner/added-at-runtime");
    rt.dispose();
  });
});
