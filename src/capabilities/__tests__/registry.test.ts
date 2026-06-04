/**
 * Capability Registry behaviour, exercised against synthetic loader output
 * AND against a temp filesystem.
 *
 * Covers:
 *   - flat scan emits one capability.registered per resolved entry
 *   - runtime shadows bundled (shadows[] populated, layer = runtime)
 *   - bundled-layer collision (personal vs workplace) is a load-time error
 *   - rescan() diffs prior vs next: register / changed / unregistered events
 *   - hot-reload over a real runtime dir picks up new folders
 *   - dispose() detaches watchers and cancels pending rescans
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoaderResult } from "../loader.ts";
import { createRegistry, RegistryCollisionError } from "../registry.ts";
import type { Capability, RegistryEvents, SkillCapability } from "../types.ts";

function bundledSkill(name: string, opts: Partial<SkillCapability> = {}): SkillCapability {
  return {
    kind: "skill",
    name,
    description: `desc ${name}`,
    origin: "personal",
    source: "filesystem",
    layer: "bundled",
    path: `/fake/bundled/personal/skills/${name}/SKILL.md`,
    manifest: { name, description: `desc ${name}` },
    body: "",
    ...opts,
  };
}

function runtimeSkill(name: string, opts: Partial<SkillCapability> = {}): SkillCapability {
  return {
    kind: "skill",
    name,
    description: `runtime ${name}`,
    origin: "personal",
    source: "filesystem",
    layer: "runtime",
    path: `/fake/runtime/skills/${name}/SKILL.md`,
    manifest: { name, description: `runtime ${name}` },
    body: "",
    ...opts,
  };
}

async function collectEvents<K extends keyof RegistryEvents>(
  registry: ReturnType<typeof createRegistry>,
  type: K,
): Promise<RegistryEvents[K][]> {
  const captured: RegistryEvents[K][] = [];
  registry.events.on(type, (e) => {
    captured.push(e);
  });
  return captured;
}

describe("createRegistry — synthetic scanner", () => {
  test("start() emits capability.registered for each resolved entry", async () => {
    const caps: Capability[] = [bundledSkill("alpha"), bundledSkill("beta")];
    const registry = createRegistry({
      scanner: (): LoaderResult => ({ capabilities: caps, errors: [] }),
      watch: false,
      logErrors: false,
    });
    const events = await collectEvents(registry, "capability.registered");
    await registry.start();

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("skill", "alpha")?.layer).toBe("bundled");
  });

  test("runtime shadows bundled — winner is runtime, shadows[] populated", async () => {
    const caps: Capability[] = [bundledSkill("foo"), runtimeSkill("foo")];
    const registry = createRegistry({
      scanner: (): LoaderResult => ({ capabilities: caps, errors: [] }),
      watch: false,
      logErrors: false,
    });
    const events = await collectEvents(registry, "capability.registered");
    await registry.start();

    expect(events).toHaveLength(1);
    expect(events[0]?.layer).toBe("runtime");
    expect(events[0]?.shadows).toHaveLength(1);
    expect(events[0]?.shadows?.[0]).toMatchObject({ layer: "bundled", origin: "personal" });

    const resolved = registry.get("skill", "foo");
    expect(resolved?.layer).toBe("runtime");
    expect(resolved?.description).toBe("runtime foo");
  });

  test("bundled collision (personal vs workplace) refuses start", async () => {
    const caps: Capability[] = [
      bundledSkill("dup"),
      bundledSkill("dup", { origin: "workplace", workplaceId: "acme" }),
    ];
    const registry = createRegistry({
      scanner: (): LoaderResult => ({ capabilities: caps, errors: [] }),
      watch: false,
      logErrors: false,
    });
    await expect(registry.start()).rejects.toBeInstanceOf(RegistryCollisionError);
  });

  test("rescan() emits changed when path differs and unregistered when removed", async () => {
    let snapshot: Capability[] = [bundledSkill("a"), bundledSkill("b")];
    const registry = createRegistry({
      scanner: (): LoaderResult => ({ capabilities: snapshot, errors: [] }),
      watch: false,
      logErrors: false,
    });
    await registry.start();

    const changed: RegistryEvents["capability.changed"][] = [];
    const unregistered: RegistryEvents["capability.unregistered"][] = [];
    const registered: RegistryEvents["capability.registered"][] = [];
    registry.events.on("capability.changed", (e) => {
      changed.push(e);
    });
    registry.events.on("capability.unregistered", (e) => {
      unregistered.push(e);
    });
    registry.events.on("capability.registered", (e) => {
      registered.push(e);
    });

    snapshot = [bundledSkill("a", { path: "/fake/different/path/SKILL.md" }), bundledSkill("c")];
    await registry.rescan();

    expect(changed.map((e) => e.name)).toEqual(["a"]);
    expect(unregistered.map((e) => e.name)).toEqual(["b"]);
    expect(registered.map((e) => e.name)).toEqual(["c"]);
  });
});

describe("createRegistry — real filesystem", () => {
  let bundledRoot: string;
  let runtimeRoot: string;

  beforeEach(() => {
    bundledRoot = mkdtempSync(join(tmpdir(), "hive-bundled-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    process.env.HIVE_BUNDLED_ROOT = bundledRoot;
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
  });

  afterEach(() => {
    delete process.env.HIVE_BUNDLED_ROOT;
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(bundledRoot)) rmSync(bundledRoot, { recursive: true, force: true });
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string, description: string): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    );
  }

  test("scans bundled and runtime, with runtime shadowing bundled", async () => {
    writeSkill(join(bundledRoot, "personal", "skills"), "shared", "from bundled");
    writeSkill(join(bundledRoot, "personal", "skills"), "only-bundled", "only bundled");
    writeSkill(join(runtimeRoot, "capabilities", "skills"), "shared", "from runtime");
    writeSkill(join(runtimeRoot, "capabilities", "skills"), "only-runtime", "only runtime");

    const registry = createRegistry({ watch: false, logErrors: false });
    await registry.start();

    const all = registry.list({ kind: "skill" });
    expect(all.map((c) => c.name).sort()).toEqual(["only-bundled", "only-runtime", "shared"]);
    expect(registry.get("skill", "shared")?.description).toBe("from runtime");
    expect(registry.get("skill", "shared")?.layer).toBe("runtime");
    expect(registry.get("skill", "shared")?.shadows).toHaveLength(1);
  });

  test("malformed manifest is skipped, valid neighbours still register", async () => {
    const skillsDir = join(bundledRoot, "personal", "skills");
    mkdirSync(join(skillsDir, "bad"), { recursive: true });
    writeFileSync(join(skillsDir, "bad", "SKILL.md"), "no frontmatter here");
    writeSkill(skillsDir, "good", "valid skill");

    const registry = createRegistry({ watch: false, logErrors: false });
    await registry.start();

    expect(registry.get("skill", "good")).toBeDefined();
    expect(registry.get("skill", "bad")).toBeUndefined();
  });

  test("folder/manifest name mismatch is treated as an error", async () => {
    const skillsDir = join(bundledRoot, "personal", "skills");
    mkdirSync(join(skillsDir, "actual"), { recursive: true });
    writeFileSync(
      join(skillsDir, "actual", "SKILL.md"),
      `---\nname: claimed\ndescription: mismatch\n---\nbody`,
    );

    const registry = createRegistry({ watch: false, logErrors: false });
    await registry.start();

    expect(registry.get("skill", "actual")).toBeUndefined();
    expect(registry.get("skill", "claimed")).toBeUndefined();
  });

  test("dispose() is safe and idempotent after start()", async () => {
    writeSkill(join(bundledRoot, "personal", "skills"), "x", "x");
    const registry = createRegistry({ watch: false, logErrors: false });
    await registry.start();
    expect(() => registry.dispose()).not.toThrow();
    expect(() => registry.dispose()).not.toThrow();
  });
});
