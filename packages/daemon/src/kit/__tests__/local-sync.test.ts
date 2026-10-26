// Local Sync: a bundled fixture Source's content reaches a Mirror through the
// one Sync path with no network, keeps the last good Mirror on failure, fails a
// missing root as missing_local_root, and never calls fetch for a local Source.
// Redirected temp homes only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@hive/contract";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { SourceRegistry, SourceRegistryLive } from "../../sources/effect/sources-live.ts";
import { SyncError } from "../effect/errors.ts";
import { Kit, KitLive } from "../effect/kit-live.ts";
import { readMirrorRecord } from "../mirror.ts";
import { type HttpFetch, syncLocatorSource } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;
let fixtureRoot: string;

// A throwing fetch — any call means the local path wrongly went to the network.
const NEVER_FETCH: HttpFetch = async () => {
  throw new Error("local Sync must not fetch");
};

// Build a minimal fixture content root (capabilities/ + presets/) in a temp dir.
function makeFixture(root: string): void {
  const skill = join(root, "capabilities", "skills", "demo-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: demo-skill\ndescription: a demo skill for the local-sync fixture\n---\nbody\n",
  );
  const presets = join(root, "presets");
  mkdirSync(presets, { recursive: true });
  writeFileSync(
    join(presets, "demo.yaml"),
    "name: demo\ndescription: demo preset\ndefault_agents: [claude]\ncapabilities:\n  skills: [demo-skill]\n",
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "local-sync-"));
  redirectHomeEnv(tmpRoot);
  fixtureRoot = join(tmpRoot, "fixtures", "demo");
  makeFixture(fixtureRoot);
  process.env.HIVE_FIXTURE_SOURCES_ROOT = join(tmpRoot, "fixtures");
});

afterEach(() => {
  delete process.env.HIVE_FIXTURE_SOURCES_ROOT;
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const FIXTURE: Source = {
  id: "fixture-demo",
  label: "Fixture demo",
  locator: { kind: "starter" },
  origin: "local:fixture-demo",
  kind: "local",
  active: true,
  createdAt: 0,
  rank: 0,
};

const syncFixture = () => syncLocatorSource(FIXTURE, failSafeDeployTargets());

describe("Local fixture Sync", () => {
  test("copies capabilities + presets into the mirror with a bundled record", async () => {
    const mirror = failSafeDeployTargets().mirrorRoot("fixture-demo");
    await Effect.runPromise(syncFixture());

    expect(existsSync(join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(mirror, "presets", "demo.yaml"))).toBe(true);
    expect(readMirrorRecord(mirror)).toMatchObject({
      origin: { transport: "bundled" },
      recipe: { id: "capability-kit" },
    });
  });

  test("a failed sync leaves the prior mirror intact", async () => {
    const mirror = failSafeDeployTargets().mirrorRoot("fixture-demo");
    await Effect.runPromise(syncFixture());

    process.env.HIVE_FIXTURE_SOURCES_ROOT = join(tmpRoot, "does-not-exist");
    expect(Exit.isFailure(await Effect.runPromiseExit(syncFixture()))).toBe(true);
    expect(existsSync(join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md"))).toBe(true);
  });

  test("a non-existent fixture root yields a typed missing_local_root SyncError (no throw out)", async () => {
    process.env.HIVE_FIXTURE_SOURCES_ROOT = join(tmpRoot, "missing");
    const exit = await Effect.runPromiseExit(syncFixture());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("missing_local_root");
    }
  });

  test("every run re-reads the content root — content refreshes", async () => {
    const mirror = failSafeDeployTargets().mirrorRoot("fixture-demo");
    const mirrored = join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md");
    await Effect.runPromise(syncFixture());

    writeFileSync(
      join(fixtureRoot, "capabilities", "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: UPDATED description\n---\nbody\n",
    );
    expect((await Effect.runPromise(syncFixture())).status).toBe("synced");
    expect(readFileSync(mirrored, "utf8")).toContain("UPDATED description");
  });
});

// A KitLive over a memory registry seeded with one local fixture Source + N git sources.
function kitOver(
  sources: Array<{ id: string; origin: string; kind: "git" | "local"; active: boolean }>,
  fetchImpl: HttpFetch,
) {
  const sourcesLayer = SourceRegistryLive({
    mode: "memory",
    initial: sources.map((s, i) => ({
      ...s,
      label: s.id,
      locator:
        s.kind === "local"
          ? ({ kind: "starter" } as const)
          : {
              kind: "git" as const,
              repoUrl: s.origin,
              revision: { mode: "track" as const, ref: "refs/heads/main" },
              subpath: ".",
            },
      createdAt: i,
      rank: i,
    })),
  });
  const rt = ManagedRuntime.make(
    Layer.merge(KitLive({ fetch: fetchImpl }).pipe(Layer.provide(sourcesLayer)), sourcesLayer),
  );
  return { kit: rt.runSync(Kit), registry: rt.runSync(SourceRegistry), rt };
}

describe("Kit.sync — local kind dispatch", () => {
  test("a local Source syncs by copy; fetch is NEVER called; catalog lists it; status is local", async () => {
    const { kit, rt } = kitOver(
      [{ id: "fixture-demo", origin: "local:fixture-demo", kind: "local", active: true }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.status).toBe("synced");

    const mirror = failSafeDeployTargets().mirrorRoot("fixture-demo");
    expect(existsSync(join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md"))).toBe(true);
    expect(readMirrorRecord(mirror)?.origin).toEqual({ transport: "bundled" });

    const cat = kit.catalog();
    expect(cat.entries.some((e) => e.kind === "skill" && e.name === "demo-skill")).toBe(true);
    expect(cat.presets.some((p) => p.name === "demo")).toBe(true);

    const state = kit.state();
    expect(state.sync[0]?.state).toBe("local");
    expect(state.sync[0]?.sha).toBeNull();
    rt.dispose();
  });

  test("a local-sync failure is isolated to that Source's status; the loop completes", async () => {
    process.env.HIVE_FIXTURE_SOURCES_ROOT = join(tmpRoot, "missing-root");
    const { kit, rt } = kitOver(
      [{ id: "fixture-demo", origin: "local:fixture-demo", kind: "local", active: true }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    expect(result.sources[0]?.status).toBe("failed");
    expect(result.sources[0]?.errorReason).toBe("missing_local_root");
    // The run completed (no thrown defect) and state still has the row — AND the
    // durable freshness view must NOT mask the failure as the healthy "local"
    // state; it reports check_failed with the reason.
    const state = kit.state();
    expect(state.sync).toHaveLength(1);
    expect(state.sync[0]?.state).toBe("check_failed");
    expect(state.sync[0]?.errorReason).toBe("missing_local_root");
    rt.dispose();
  });

  test("an unknown local Source origin fails that Source instead of copying fixture bytes", async () => {
    const { kit, rt } = kitOver(
      [{ id: "mystery", origin: "local:mystery", kind: "local", active: true }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    expect(result.sources).toEqual([
      {
        sourceId: "mystery",
        status: "failed",
        errorReason: "missing_local_root",
        errorDetail: "local content root is unavailable",
      },
    ]);
    expect(kit.catalog().entries.some((e) => e.sourceIds.includes("mystery"))).toBe(false);
    rt.dispose();
  });

  test("a deactivated fixture Source is excluded from catalog() and skipped by sync", async () => {
    const { kit, rt } = kitOver(
      [{ id: "fixture-demo", origin: "local:fixture-demo", kind: "local", active: false }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    // Inactive → not synced at all.
    expect(result.sources).toHaveLength(0);
    const mirror = failSafeDeployTargets().mirrorRoot("fixture-demo");
    expect(existsSync(join(mirror, "capabilities"))).toBe(false);
    // catalog() omits the fixture Source's capabilities.
    expect(kit.catalog().entries.some((e) => e.name === "demo-skill")).toBe(false);
    rt.dispose();
  });
});

describe("deploy from the local mirror while offline", () => {
  test("deploying a fixture preset's skill lands files in the redirected ~/.claude with no exec", async () => {
    const execCalls: string[] = [];
    const sourcesLayer = SourceRegistryLive({
      mode: "memory",
      initial: [
        {
          id: "fixture-demo",
          label: "Fixture demo",
          locator: { kind: "starter" },
          origin: "local:fixture-demo",
          kind: "local",
          active: true,
          createdAt: 0,
          rank: 0,
        },
      ],
    });
    const rt = ManagedRuntime.make(
      Layer.merge(
        KitLive({
          fetch: NEVER_FETCH,
          exec: async (req) => {
            execCalls.push(req.command);
            return { status: 0, stdout: "", stderr: "" };
          },
          probe: async () => true,
        }).pipe(Layer.provide(sourcesLayer)),
        sourcesLayer,
      ),
    );
    const kit = rt.runSync(Kit);

    await Effect.runPromise(kit.sync());
    const selection = kit.selection();
    await kit.mutateSelection({
      expectedRevision: selection.revision,
      changes: [
        {
          key: { kind: "skill", name: "demo-skill" },
          enabled: true,
          targets: ["claude"],
        },
      ],
    });
    const reviewed = kit.overview();
    await kit.acceptDeploy({
      selectionRevision: reviewed.selectionRevision,
      planToken: reviewed.planToken,
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (kit.overview().lastOperation?.state === "completed") break;
      await Bun.sleep(5);
    }
    expect(kit.overview().lastOperation?.state).toBe("completed");

    const claudeHome = failSafeDeployTargets().claudeHome();
    expect(existsSync(join(claudeHome, "skills", "demo-skill", "SKILL.md"))).toBe(true);
    // No external installer ran (a skill deploy is pure fs copy).
    expect(execCalls).toHaveLength(0);
    rt.dispose();
  });
});
