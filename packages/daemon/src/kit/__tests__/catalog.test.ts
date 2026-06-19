import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCatalog } from "../catalog.ts";
import { DeployError } from "../effect/errors.ts";
import { resolveSelection } from "../selection.ts";
import { defaultDeployTargets } from "../targets.ts";
import type { Selection } from "../types.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const CLONE = "D:/GitRepos/my-agent-kits";

let tmpRoot: string;
let mirror: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  mirror = defaultDeployTargets().mirrorRoot();
  mkdirSync(join(mirror, "capabilities", "skills"), { recursive: true });
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSkill(rel: string, frontmatter: string, body = "body"): void {
  const dir = join(mirror, "capabilities", "skills", rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

function emptySelection(over: Partial<Selection["add"]>): Selection {
  return {
    presets: [],
    add: {
      instructions: [],
      skills: [],
      agents: [],
      plugins: [],
      bundles: [],
      ...over,
    },
    remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
    targets: ["claude"],
  };
}

describe("readCatalog", () => {
  test("(a) @-group flatten: leaf name + group path are content-derived", () => {
    writeSkill("@grp/@sub/foo", "description: nested foo");
    const cat = readCatalog(defaultDeployTargets());
    const foo = cat.entries.find((e) => e.kind === "skill" && e.name === "foo");
    expect(foo).toBeDefined();
    expect(foo?.name).toBe("foo");
    expect(foo?.group).toBe("@grp/@sub");
    expect(foo?.deployable).toBe(true);
  });

  test("(b) within-kind collision blocks both, and resolveSelection throws", () => {
    writeSkill("@a/foo", "description: a-foo");
    writeSkill("@b/foo", "description: b-foo");
    const cat = readCatalog(defaultDeployTargets());

    const foos = cat.entries.filter((e) => e.kind === "skill" && e.name === "foo");
    expect(foos.length).toBe(2);
    for (const f of foos) {
      expect(f.deployable).toBe(false);
      expect(f.blockedReason).toBeDefined();
    }
    expect(cat.problems.some((p) => p.kind === "skill" && p.name === "foo")).toBe(true);

    let thrown: unknown;
    try {
      resolveSelection(cat, emptySelection({ skills: ["foo"] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DeployError);
    expect((thrown as DeployError).reason).toBe("collision");
  });

  test("(c) malformed entries skipped, not fatal; problems[] lists the bad ones", () => {
    // A well-formed skill survives.
    writeSkill("good", "description: good skill");
    // Broken YAML frontmatter (lenient parse -> {} description, still listed).
    writeSkill("broken", "description: [unterminated\n  bad: : :");

    // Cyclic preset pair.
    const presets = join(mirror, "presets");
    mkdirSync(presets, { recursive: true });
    writeFileSync(join(presets, "a.yaml"), "name: a\nextends: b\ncapabilities: {}\n");
    writeFileSync(join(presets, "b.yaml"), "name: b\nextends: a\ncapabilities: {}\n");

    const cat = readCatalog(defaultDeployTargets());

    // The good skill still loads.
    expect(cat.entries.some((e) => e.name === "good")).toBe(true);
    // Cyclic presets are surfaced as problems, never resolved.
    expect(cat.presets.some((p) => p.name === "a" || p.name === "b")).toBe(false);
    expect(cat.problems.some((p) => p.kind === "preset")).toBe(true);
  });

  test("(d) presets resolve incl extends-union (deduped)", () => {
    writeSkill("alpha", "description: a");
    writeSkill("beta", "description: b");
    writeSkill("gamma", "description: g");

    const presets = join(mirror, "presets");
    mkdirSync(presets, { recursive: true });
    writeFileSync(
      join(presets, "parent.yaml"),
      "name: parent\ndefault_agents: [claude]\ncapabilities:\n  skills: [alpha, beta]\n",
    );
    writeFileSync(
      join(presets, "child.yaml"),
      "name: child\nextends: parent\ndefault_agents: [claude]\ncapabilities:\n  skills: [beta, gamma]\n",
    );

    const cat = readCatalog(defaultDeployTargets());
    const child = cat.presets.find((p) => p.name === "child");
    expect(child).toBeDefined();
    expect(new Set(child?.capabilities.skills)).toEqual(new Set(["alpha", "beta", "gamma"]));
    // deduped (beta appears once)
    expect(child?.capabilities.skills.filter((s) => s === "beta").length).toBe(1);
  });

  test("loads the real clone catalog without throwing (realistic content)", () => {
    cpSync(join(CLONE, "capabilities"), join(mirror, "capabilities"), { recursive: true });
    cpSync(join(CLONE, "presets"), join(mirror, "presets"), { recursive: true });
    const cat = readCatalog(defaultDeployTargets());
    expect(cat.entries.length).toBeGreaterThan(0);
    expect(cat.presets.some((p) => p.name === "engineering")).toBe(true);
    // my-commit ships under @my/ but flattens to the leaf name.
    expect(cat.entries.some((e) => e.kind === "skill" && e.name === "my-commit")).toBe(true);
  });
});
