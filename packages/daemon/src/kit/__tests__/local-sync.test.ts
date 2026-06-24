// Local Sync (#32): copy the bundled Starter content into a Mirror with no
// network, the atomic stage→swap reuse, no provenance, the typed
// missing_starter_root failure, and the kind-branching sync dispatch (fetch is
// never called for a local Source). Redirected temp homes only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { SourceRegistry, SourceRegistryLive } from "../../sources/effect/sources-live.ts";
import { SyncError } from "../effect/errors.ts";
import { Kit, KitLive } from "../effect/kit-live.ts";
import { localSyncMirror, mirrorExists } from "../mirror.ts";
import { type HttpFetch, localSyncSource } from "../sync.ts";
import { defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;
let starterFixture: string;

// A throwing fetch — any call means the local path wrongly went to the network.
const NEVER_FETCH: HttpFetch = async () => {
  throw new Error("local Sync must not fetch");
};

// Build a minimal Starter content root (capabilities/ + presets/) in a temp dir.
function makeStarterFixture(root: string): void {
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
  starterFixture = join(tmpRoot, "starter-pkg");
  makeStarterFixture(starterFixture);
  process.env.HIVE_STARTER_ROOT = starterFixture;
});

afterEach(() => {
  delete process.env.HIVE_STARTER_ROOT;
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("localSyncMirror / localSyncSource", () => {
  test("copies capabilities + presets into the mirror; writes NO .hive-mirror.json", () => {
    const targets = defaultDeployTargets();
    const mirror = targets.mirrorRoot("starter");
    localSyncMirror(mirror, targets.kitTmpRoot(), starterFixture);

    expect(mirrorExists(mirror)).toBe(true);
    expect(existsSync(join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(mirror, "presets", "demo.yaml"))).toBe(true);
    // No provenance file — a local mirror has no sha.
    expect(existsSync(join(mirror, ".hive-mirror.json"))).toBe(false);
  });

  test("reuses the atomic stage→swap: an interrupted stage leaves the prior mirror intact", () => {
    const targets = defaultDeployTargets();
    const mirror = targets.mirrorRoot("starter");
    // Seed a good mirror first.
    localSyncMirror(mirror, targets.kitTmpRoot(), starterFixture);
    expect(mirrorExists(mirror)).toBe(true);

    // Now a sync from a bad root throws BEFORE the swap — the prior mirror survives.
    expect(() =>
      localSyncMirror(mirror, targets.kitTmpRoot(), join(tmpRoot, "does-not-exist")),
    ).toThrow();
    expect(mirrorExists(mirror)).toBe(true);
    expect(existsSync(join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md"))).toBe(true);
  });

  test("a non-existent starterRoot yields a typed missing_starter_root SyncError (no throw out)", async () => {
    const targets = defaultDeployTargets();
    const exit = await Effect.runPromiseExit(
      localSyncSource(
        targets.mirrorRoot("starter"),
        targets.kitTmpRoot(),
        join(tmpRoot, "missing"),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("missing_starter_root");
    }
  });

  test("re-copy on every run (no sha short-circuit) — content refreshes", () => {
    const targets = defaultDeployTargets();
    const mirror = targets.mirrorRoot("starter");
    const mirrored = join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md");
    localSyncMirror(mirror, targets.kitTmpRoot(), starterFixture);

    // Mutate the source, re-sync, and observe the change propagated (no sha to
    // short-circuit on — a local mirror always re-copies).
    writeFileSync(
      join(starterFixture, "capabilities", "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: UPDATED description\n---\nbody\n",
    );
    localSyncMirror(mirror, targets.kitTmpRoot(), starterFixture);
    expect(readFileSync(mirrored, "utf8")).toContain("UPDATED description");
  });
});

// A KitLive over a memory registry seeded with one local Starter + N git sources.
function kitOver(
  sources: Array<{ id: string; origin: string; kind: "git" | "local"; active: boolean }>,
  fetchImpl: HttpFetch,
) {
  const sourcesLayer = SourceRegistryLive({
    mode: "memory",
    initial: sources.map((s, i) => ({ ...s, createdAt: i })),
  });
  const rt = ManagedRuntime.make(
    Layer.merge(KitLive({ fetch: fetchImpl }).pipe(Layer.provide(sourcesLayer)), sourcesLayer),
  );
  return { kit: rt.runSync(Kit), registry: rt.runSync(SourceRegistry), rt };
}

describe("Kit.sync — local kind dispatch (#32)", () => {
  test("a local Source syncs by copy; fetch is NEVER called; catalog lists it; status is local", async () => {
    const { kit, rt } = kitOver(
      [{ id: "starter", origin: "local:starter", kind: "local", active: true }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.status).toBe("synced");

    const mirror = defaultDeployTargets().mirrorRoot("starter");
    expect(existsSync(join(mirror, "capabilities", "skills", "demo-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(mirror, ".hive-mirror.json"))).toBe(false);

    const cat = kit.catalog();
    expect(cat.entries.some((e) => e.kind === "skill" && e.name === "demo-skill")).toBe(true);
    expect(cat.presets.some((p) => p.name === "demo")).toBe(true);

    const state = kit.state();
    expect(state.sync[0]?.state).toBe("local");
    expect(state.sync[0]?.sha).toBeNull();
    rt.dispose();
  });

  test("a local-sync failure is isolated to that Source's status; the loop completes", async () => {
    process.env.HIVE_STARTER_ROOT = join(tmpRoot, "missing-root");
    const { kit, rt } = kitOver(
      [{ id: "starter", origin: "local:starter", kind: "local", active: true }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    expect(result.sources[0]?.status).toBe("failed");
    expect(result.sources[0]?.errorReason).toBe("missing_starter_root");
    // The run completed (no thrown defect) and state still has the row — AND the
    // durable freshness view must NOT mask the failure as the healthy "local"
    // state; it reports check_failed with the reason.
    const state = kit.state();
    expect(state.sync).toHaveLength(1);
    expect(state.sync[0]?.state).toBe("check_failed");
    expect(state.sync[0]?.errorReason).toBe("missing_starter_root");
    rt.dispose();
  });

  test("a deactivated Starter is excluded from catalog() and skipped by sync", async () => {
    const { kit, rt } = kitOver(
      [{ id: "starter", origin: "local:starter", kind: "local", active: false }],
      NEVER_FETCH,
    );
    const result = await Effect.runPromise(kit.sync());
    // Inactive → not synced at all.
    expect(result.sources).toHaveLength(0);
    const mirror = defaultDeployTargets().mirrorRoot("starter");
    expect(existsSync(join(mirror, "capabilities"))).toBe(false);
    // catalog() omits the Starter's capabilities.
    expect(kit.catalog().entries.some((e) => e.name === "demo-skill")).toBe(false);
    rt.dispose();
  });
});

describe("deploy from the local mirror (#32, offline)", () => {
  test("deploying the Starter preset's skill lands files in the redirected ~/.claude with no exec", async () => {
    const execCalls: string[] = [];
    const sourcesLayer = SourceRegistryLive({
      mode: "memory",
      initial: [
        { id: "starter", origin: "local:starter", kind: "local", active: true, createdAt: 0 },
      ],
    });
    const rt = ManagedRuntime.make(
      Layer.merge(
        KitLive({
          fetch: NEVER_FETCH,
          exec: (req) => {
            execCalls.push(req.command);
            return { status: 0, stdout: "", stderr: "" };
          },
          probe: () => true,
        }).pipe(Layer.provide(sourcesLayer)),
        sourcesLayer,
      ),
    );
    const kit = rt.runSync(Kit);

    await Effect.runPromise(kit.sync());
    await Effect.runPromise(
      kit.deploy({
        presets: [],
        add: { instructions: [], skills: ["demo-skill"], agents: [], plugins: [], bundles: [] },
        remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
        targets: ["claude"],
      }),
    );

    const claudeHome = defaultDeployTargets().claudeHome();
    expect(existsSync(join(claudeHome, "skills", "demo-skill", "SKILL.md"))).toBe(true);
    // No external installer ran (a skill deploy is pure fs copy).
    expect(execCalls).toHaveLength(0);
    rt.dispose();
  });
});
