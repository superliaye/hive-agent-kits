import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, Source } from "@hive/contract";
import { Effect } from "effect";
import { readCatalog } from "../catalog.ts";
import type { DeployFsExec } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { DeployError } from "../effect/errors.ts";
import type { ResolvedSelection } from "../selection.ts";
import { computeDiff } from "../selection.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SOURCE_ID = "src-1";

let tmpRoot: string;
let targets: DeployTargets;
let mirror: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  targets = defaultDeployTargets();
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

function resolved(over: Partial<ResolvedSelection>): ResolvedSelection {
  return {
    instructions: [],
    skills: [],
    agents: [],
    plugins: [],
    bundles: [],
    targets: ["claude"],
    ...over,
  };
}

const fx = (): DeployFsExec => ({
  targets,
  exec: () => ({ status: 0, stdout: "", stderr: "" }),
  probe: () => true,
});

const SOURCE: Source = {
  id: SOURCE_ID,
  origin: "https://github.com/owner/repo",
  active: true,
  createdAt: 0,
};
const cat = (): Catalog => readCatalog(targets, [SOURCE]);

async function deploy(sel: ResolvedSelection): Promise<void> {
  await Effect.runPromise(
    runDeploy(fx(), { selection: sel, kitSha: "sha1", kitVersion: "1.0.0", mirrorRoots: [mirror] }),
  );
}

describe("computeDiff", () => {
  test("(a) added: nothing deployed, select skills -> all added", () => {
    seedSkill("x");
    seedSkill("y");
    const diff = computeDiff(targets, [mirror], cat(), resolved({ skills: ["x", "y"] }));
    const added = diff.entries.filter((e) => e.change === "added").map((e) => e.name);
    expect(new Set(added)).toEqual(new Set(["x", "y"]));
    expect(diff.entries.every((e) => e.change === "added")).toBe(true);
  });

  test("(b) removed: ledger owns {a,b}, select {a} -> b removed", async () => {
    seedSkill("a");
    seedSkill("b");
    await deploy(resolved({ skills: ["a", "b"] }));

    const diff = computeDiff(targets, [mirror], cat(), resolved({ skills: ["a"] }));
    const removed = diff.entries.filter((e) => e.change === "removed");
    expect(removed.map((e) => e.name)).toEqual(["b"]);
  });

  test("(c) changed-by-content: mutate the mirror source so the rendered hash differs", async () => {
    seedSkill("c", "original body");
    await deploy(resolved({ skills: ["c"] }));
    // Mutate the mirror source so a re-deploy WOULD write different bytes.
    seedSkill("c", "MUTATED body");

    const diff = computeDiff(targets, [mirror], cat(), resolved({ skills: ["c"] }));
    const changed = diff.entries.find((e) => e.kind === "skill" && e.name === "c");
    expect(changed).toBeDefined();
    expect(changed?.change).toBe("changed");
  });

  test("(d) CLAUDE.md user-file warning: pre-place a non-Kit CLAUDE.md", () => {
    seedInstruction("core", "core body");
    // A user-authored CLAUDE.md exists, but the ledger has no instructions.
    mkdirSync(targets.claudeHome(), { recursive: true });
    writeFileSync(join(targets.claudeHome(), "CLAUDE.md"), "USER WROTE THIS");

    const diff = computeDiff(targets, [mirror], cat(), resolved({ instructions: ["core"] }));
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
    const diff = computeDiff(targets, [mirror], cat(), codexOnly);
    expect(diff.entries.filter((d) => d.kind === "skill")).toEqual([]);
  });

  test("(f) codex-only: an existing user AGENTS.md triggers the user-file warning", () => {
    seedInstruction("core", "core body");
    mkdirSync(targets.codexHome(), { recursive: true });
    writeFileSync(join(targets.codexHome(), "AGENTS.md"), "USER WROTE THIS CODEX FILE");
    const diff = computeDiff(
      targets,
      [mirror],
      cat(),
      resolved({ instructions: ["core"], targets: ["codex"] }),
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
      computeDiff(targets, [mirrorA, mirrorB], cat(), resolved({ skills: [] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DeployError);
    expect((thrown as DeployError).reason).toBe("collision");
    expect((thrown as DeployError).name).toBe("shared");
  });
});
