import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog } from "@hive/contract";
import { Effect } from "effect";
import type { DeployFsExec } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { DeployError } from "../effect/errors.ts";
import type { ResolvedSelection } from "../selection.ts";
import { catalogNameSets, computeDiff } from "../selection.ts";
import { type DeployTargets, failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

// Active-catalog name-sets for the given per-kind names — the membership signal
// computeDiff/reconcilePrune use to decide an owned-but-deselected name is a real
// removal (its Source is active) vs an orphan (its Source is absent → kept). An
// empty default means "no active Source provides anything", the first-load bug.
function activeNames(over: { skills?: string[]; agents?: string[] } = {}) {
  return catalogNameSets({
    entries: [
      ...(over.skills ?? []).map((name) => entry("skill", name)),
      ...(over.agents ?? []).map((name) => entry("agent", name)),
    ],
    presets: [],
    problems: [],
  });
}

function entry(kind: "skill" | "agent", name: string): Catalog["entries"][number] {
  return {
    kind,
    name,
    description: "",
    group: "",
    deployable: true,
    shadowed: false,
    sourceIds: [SOURCE_ID],
    contentSha: "a".repeat(64),
  };
}

const SOURCE_ID = "src-1";

let tmpRoot: string;
let targets: DeployTargets;
let mirror: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  targets = failSafeDeployTargets();
  mirror = targets.mirrorRoot(SOURCE_ID);
  mkdirSync(mirror, { recursive: true });
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedSkill(name: string, body = `skill body ${name}`): void {
  const dir = join(mirror, "capabilities", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\ndescription: s\n---\n${body}\n`);
}

function seedInstruction(name: string, body: string): void {
  const dir = join(mirror, "capabilities", "instructions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.instructions.md`), `---\ndescription: ${name}\n---\n${body}\n`);
}

function resolved(over: {
  instructions?: string[];
  skills?: string[];
  agents?: string[];
  plugins?: string[];
  bundles?: string[];
  targets?: ("claude" | "codex")[];
}): ResolvedSelection {
  const item = (n: string) => ({ name: n, sourceId: SOURCE_ID });
  return {
    instructions: (over.instructions ?? []).map(item),
    skills: (over.skills ?? []).map(item),
    agents: (over.agents ?? []).map(item),
    plugins: (over.plugins ?? []).map(item),
    bundles: (over.bundles ?? []).map(item),
    targets: over.targets ?? ["claude"],
  };
}

const fx = (): DeployFsExec => ({
  targets,
  exec: () => ({ status: 0, stdout: "", stderr: "" }),
  probe: () => true,
});

async function deploy(sel: ResolvedSelection): Promise<void> {
  await Effect.runPromise(
    runDeploy(fx(), {
      selection: sel,
      kitSha: "sha1",
      kitVersion: "1.0.0",
      activeMirrorRoots: [mirror],
      // These deploys seed the ledger; every seeded name is active here.
      activeCatalogNames: {
        skills: sel.skills.map((i) => i.name),
        agents: sel.agents.map((i) => i.name),
      },
    }),
  );
}

describe("computeDiff", () => {
  test("(a) added: nothing deployed, select skills -> all added", () => {
    seedSkill("x");
    seedSkill("y");
    const diff = computeDiff(
      targets,
      [mirror],
      resolved({ skills: ["x", "y"] }),
      activeNames({ skills: ["x", "y"] }),
    );
    const added = diff.entries.filter((e) => e.change === "added").map((e) => e.name);
    expect(new Set(added)).toEqual(new Set(["x", "y"]));
    expect(diff.entries.every((e) => e.change === "added")).toBe(true);
  });

  test("(b) removed: ledger owns {a,b}, select {a} -> b removed", async () => {
    seedSkill("a");
    seedSkill("b");
    await deploy(resolved({ skills: ["a", "b"] }));

    const diff = computeDiff(
      targets,
      [mirror],
      resolved({ skills: ["a"] }),
      activeNames({ skills: ["a", "b"] }),
    );
    const removed = diff.entries.filter((e) => e.change === "removed");
    expect(removed.map((e) => e.name)).toEqual(["b"]);
  });

  test("(c) changed-by-content: mutate the mirror source so the rendered hash differs", async () => {
    seedSkill("c", "original body");
    await deploy(resolved({ skills: ["c"] }));
    // Mutate the mirror source so a re-deploy WOULD write different bytes.
    seedSkill("c", "MUTATED body");

    const diff = computeDiff(
      targets,
      [mirror],
      resolved({ skills: ["c"] }),
      activeNames({ skills: ["c"] }),
    );
    const changed = diff.entries.find((e) => e.kind === "skill" && e.name === "c");
    expect(changed).toBeDefined();
    expect(changed?.change).toBe("changed");
  });

  test("(d) CLAUDE.md user-file warning: pre-place a non-Kit CLAUDE.md", () => {
    seedInstruction("core", "core body");
    // A user-authored CLAUDE.md exists, but the ledger has no instructions.
    mkdirSync(targets.claudeHome(), { recursive: true });
    writeFileSync(join(targets.claudeHome(), "CLAUDE.md"), "USER WROTE THIS");

    const diff = computeDiff(
      targets,
      [mirror],
      resolved({ instructions: ["core"] }),
      activeNames(),
    );
    const instr = diff.entries.find((e) => e.kind === "instruction" && e.name === "core");
    expect(instr).toBeDefined();
    expect(instr?.change).toBe("added");
    expect(instr?.replacesUserFile).toBe(true);
  });

  test("(e) codex-only: an unchanged redeploy diffs against the CODEX homes, not claude", async () => {
    seedSkill("z", "stable body");
    const codexOnly = resolved({ skills: ["z"], targets: ["codex"] });
    await deploy(codexOnly);
    // Re-diff the SAME selection with no source change: it must be unchanged
    // (no entries), proving the diff reads the codex home (agentsHome) the deploy
    // wrote to — not claudeHome (which a codex-only deploy never touches).
    const diff = computeDiff(targets, [mirror], codexOnly, activeNames({ skills: ["z"] }));
    expect(diff.entries.filter((d) => d.kind === "skill")).toEqual([]);
  });

  test("(f) codex-only: an existing user AGENTS.md triggers the user-file warning", () => {
    seedInstruction("core", "core body");
    mkdirSync(targets.codexHome(), { recursive: true });
    writeFileSync(join(targets.codexHome(), "AGENTS.md"), "USER WROTE THIS CODEX FILE");
    const diff = computeDiff(
      targets,
      [mirror],
      resolved({ instructions: ["core"], targets: ["codex"] }),
      activeNames(),
    );
    const instr = diff.entries.find((e) => e.kind === "instruction" && e.name === "core");
    expect(instr?.replacesUserFile).toBe(true);
  });

  test("(g) cross-Source snippet collision is surfaced in the DIFF path (not just deploy)", () => {
    // Two active mirrors both ship snippets/shared.md → the diff must fail the
    // same typed collision the deploy would, so the preview can't say "ok".
    const mirrorA = targets.mirrorRoot("src-a");
    const mirrorB = targets.mirrorRoot("src-b");
    for (const m of [mirrorA, mirrorB]) {
      mkdirSync(join(m, "capabilities", "snippets"), { recursive: true });
    }
    writeFileSync(join(mirrorA, "capabilities", "snippets", "shared.md"), "from A");
    writeFileSync(join(mirrorB, "capabilities", "snippets", "shared.md"), "from B");

    let thrown: unknown;
    try {
      computeDiff(targets, [mirrorA, mirrorB], resolved({ skills: [] }), activeNames());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DeployError);
    expect((thrown as DeployError).reason).toBe("collision");
    expect((thrown as DeployError).name).toBe("shared");
  });

  // #47 data-loss guard: an owned-but-deselected name is "removed" ONLY when its
  // name is in the active catalog. Owned-but-absent (its Source isn't active) is an
  // ORPHAN — no diff entry, never auto-deleted.
  test("(h) #47: an owned skill absent from the active catalog produces NO removed entry; an owned+active one IS removed", async () => {
    seedSkill("active-one");
    seedSkill("orphan-one");
    // Ledger owns both after a deploy while both Sources were active.
    await deploy(resolved({ skills: ["active-one", "orphan-one"] }));

    // Now the orphan's Source is inactive: the active catalog provides only
    // `active-one`. Deselect BOTH. Only the active-catalog name is a real removal;
    // the orphan yields no diff entry.
    const diff = computeDiff(
      targets,
      [mirror],
      resolved({ skills: [] }),
      activeNames({ skills: ["active-one"] }),
    );
    const removed = diff.entries.filter((e) => e.change === "removed").map((e) => e.name);
    expect(removed).toEqual(["active-one"]);
    expect(diff.entries.some((e) => e.name === "orphan-one")).toBe(false);
  });

  test("(i) #47: first load — every owned name absent from the active catalog yields zero removed", async () => {
    seedSkill("s1");
    seedSkill("s2");
    await deploy(resolved({ skills: ["s1", "s2"] }));
    // First load with no active Source providing these names (all owned names are
    // orphans): the seeded selection equals the ledger, and the active catalog is
    // empty — the diff must be empty, not a destructive "removed" set.
    const diff = computeDiff(targets, [mirror], resolved({ skills: ["s1", "s2"] }), activeNames());
    expect(diff.entries.filter((e) => e.change === "removed")).toEqual([]);
  });

  test("(j) #47: an owned agent absent from the active catalog is not removed (agents loop)", async () => {
    // Owned agent with no active-catalog membership → orphan, no diff entry.
    await deploy(resolved({ skills: [] }));
    // Seed a ledger that owns an agent the active catalog no longer provides.
    const { mergeLedger } = await import("../ledger.ts");
    mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: [],
        agents: ["ghost-agent"],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const diff = computeDiff(targets, [mirror], resolved({ agents: [] }), activeNames());
    expect(diff.entries.some((e) => e.kind === "agent" && e.name === "ghost-agent")).toBe(false);
  });
});
