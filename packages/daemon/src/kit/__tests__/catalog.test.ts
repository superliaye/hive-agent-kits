import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Selection, Source } from "@hive/contract";
import { readCatalog } from "../catalog.ts";
import { DeployError } from "../effect/errors.ts";
import { resolveSelection } from "../selection.ts";
import { defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const CLONE = "D:/GitRepos/my-agent-kits";

function source(id: string, over: Partial<Source> = {}): Source {
  return { id, origin: `https://github.com/owner/${id}`, active: true, createdAt: 0, ...over };
}

let tmpRoot: string;
// Default single pre-added Source mirror.
let mirror: string;
const SOURCE = source("src-1");

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  mirror = defaultDeployTargets().mirrorRoot(SOURCE.id);
  mkdirSync(join(mirror, "capabilities", "skills"), { recursive: true });
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSkillIn(mirrorRoot: string, rel: string, frontmatter: string, body = "body"): void {
  const dir = join(mirrorRoot, "capabilities", "skills", rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

function writeSkill(rel: string, frontmatter: string, body = "body"): void {
  writeSkillIn(mirror, rel, frontmatter, body);
}

function writeInstructionIn(mirrorRoot: string, name: string, body = "instr"): void {
  const dir = join(mirrorRoot, "capabilities", "instructions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.instructions.md`), `---\ndescription: ${name}\n---\n${body}\n`);
}

function writePresetIn(mirrorRoot: string, name: string, yaml: string): void {
  const presets = join(mirrorRoot, "presets");
  mkdirSync(presets, { recursive: true });
  writeFileSync(join(presets, `${name}.yaml`), yaml);
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

describe("readCatalog (single Source)", () => {
  test("(a) @-group flatten: leaf name + group path are content-derived", () => {
    writeSkill("@grp/@sub/foo", "description: nested foo");
    const cat = readCatalog(defaultDeployTargets(), [SOURCE]);
    const foo = cat.entries.find((e) => e.kind === "skill" && e.name === "foo");
    expect(foo).toBeDefined();
    expect(foo?.name).toBe("foo");
    expect(foo?.group).toBe("@grp/@sub");
    expect(foo?.deployable).toBe(true);
  });

  test("(b) within-kind collision blocks both, and resolveSelection throws", () => {
    writeSkill("@a/foo", "description: a-foo");
    writeSkill("@b/foo", "description: b-foo");
    const cat = readCatalog(defaultDeployTargets(), [SOURCE]);

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
    writeSkill("good", "description: good skill");
    writeSkill("broken", "description: [unterminated\n  bad: : :");

    writePresetIn(mirror, "a", "name: a\nextends: b\ncapabilities: {}\n");
    writePresetIn(mirror, "b", "name: b\nextends: a\ncapabilities: {}\n");

    const cat = readCatalog(defaultDeployTargets(), [SOURCE]);

    expect(cat.entries.some((e) => e.name === "good")).toBe(true);
    expect(cat.presets.some((p) => p.name === "a" || p.name === "b")).toBe(false);
    expect(cat.problems.some((p) => p.kind === "preset")).toBe(true);
  });

  test("(d) presets resolve incl extends-union (deduped)", () => {
    writeSkill("alpha", "description: a");
    writeSkill("beta", "description: b");
    writeSkill("gamma", "description: g");

    writePresetIn(
      mirror,
      "parent",
      "name: parent\ndefault_agents: [claude]\ncapabilities:\n  skills: [alpha, beta]\n",
    );
    writePresetIn(
      mirror,
      "child",
      "name: child\nextends: parent\ndefault_agents: [claude]\ncapabilities:\n  skills: [beta, gamma]\n",
    );

    const cat = readCatalog(defaultDeployTargets(), [SOURCE]);
    const child = cat.presets.find((p) => p.name === "child");
    expect(child).toBeDefined();
    expect(new Set(child?.capabilities.skills)).toEqual(new Set(["alpha", "beta", "gamma"]));
    expect(child?.capabilities.skills.filter((s) => s === "beta").length).toBe(1);
  });

  test("loads the real clone catalog without throwing (realistic content)", () => {
    cpSync(join(CLONE, "capabilities"), join(mirror, "capabilities"), { recursive: true });
    cpSync(join(CLONE, "presets"), join(mirror, "presets"), { recursive: true });
    const cat = readCatalog(defaultDeployTargets(), [SOURCE]);
    expect(cat.entries.length).toBeGreaterThan(0);
    expect(cat.presets.some((p) => p.name === "engineering")).toBe(true);
    // my-commit ships under @my/ but flattens to the leaf name.
    expect(cat.entries.some((e) => e.kind === "skill" && e.name === "my-commit")).toBe(true);
  });
});

describe("readCatalog (cross-Source aggregation)", () => {
  const SRC_A = source("src-a");
  const SRC_B = source("src-b");
  let mirrorA: string;
  let mirrorB: string;

  beforeEach(() => {
    mirrorA = defaultDeployTargets().mirrorRoot(SRC_A.id);
    mirrorB = defaultDeployTargets().mirrorRoot(SRC_B.id);
    mkdirSync(join(mirrorA, "capabilities"), { recursive: true });
    mkdirSync(join(mirrorB, "capabilities"), { recursive: true });
  });

  test("(a) disjoint capability names across two Sources -> all deployable", () => {
    writeSkillIn(mirrorA, "alpha", "description: a");
    writeSkillIn(mirrorB, "beta", "description: b");
    const cat = readCatalog(defaultDeployTargets(), [SRC_A, SRC_B]);
    const alpha = cat.entries.find((e) => e.name === "alpha");
    const beta = cat.entries.find((e) => e.name === "beta");
    expect(alpha?.deployable).toBe(true);
    expect(beta?.deployable).toBe(true);
  });

  test("(b) same skill name in two Sources -> both un-deployable + a collision problem", () => {
    writeSkillIn(mirrorA, "foo", "description: a-foo");
    writeSkillIn(mirrorB, "foo", "description: b-foo");
    const cat = readCatalog(defaultDeployTargets(), [SRC_A, SRC_B]);
    const foos = cat.entries.filter((e) => e.kind === "skill" && e.name === "foo");
    expect(foos.length).toBe(2);
    for (const f of foos) {
      expect(f.deployable).toBe(false);
      expect(f.blockedReason).toBe("cross-source CapabilityKey collision — un-deployable");
    }
    expect(
      cat.problems.some(
        (p) =>
          p.kind === "skill" &&
          p.name === "foo" &&
          p.problem === "cross-source CapabilityKey collision — un-deployable",
      ),
    ).toBe(true);
  });

  test("(c) same-named instruction across two Sources -> both un-deployable (file-marker kind)", () => {
    writeInstructionIn(mirrorA, "core", "a-core");
    writeInstructionIn(mirrorB, "core", "b-core");
    const cat = readCatalog(defaultDeployTargets(), [SRC_A, SRC_B]);
    const instrs = cat.entries.filter((e) => e.kind === "instruction" && e.name === "core");
    expect(instrs.length).toBe(2);
    for (const i of instrs) expect(i.deployable).toBe(false);
    expect(cat.problems.some((p) => p.kind === "instruction" && p.name === "core")).toBe(true);
  });

  test("(d) same-named preset across two Sources -> dropped + problem (not first-wins)", () => {
    writeSkillIn(mirrorA, "alpha", "description: a");
    writeSkillIn(mirrorB, "alpha", "description: b2");
    writePresetIn(
      mirrorA,
      "shared",
      "name: shared\ndefault_agents: [claude]\ncapabilities:\n  skills: [alpha]\n",
    );
    writePresetIn(
      mirrorB,
      "shared",
      "name: shared\ndefault_agents: [claude]\ncapabilities:\n  skills: [alpha]\n",
    );
    const cat = readCatalog(defaultDeployTargets(), [SRC_A, SRC_B]);
    expect(cat.presets.some((p) => p.name === "shared")).toBe(false);
    expect(cat.problems.some((p) => p.kind === "preset" && p.name === "shared")).toBe(true);
  });
});
