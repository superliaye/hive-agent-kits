import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readCatalog } from "../catalog.ts";
import type { DeployFsExec } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { computeDiff } from "../selection.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import type { Catalog, ResolvedSelection } from "../types.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;
let targets: DeployTargets;
let mirror: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  targets = defaultDeployTargets();
  mirror = targets.mirrorRoot();
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

const cat = (): Catalog => readCatalog(targets);

async function deploy(sel: ResolvedSelection): Promise<void> {
  await Effect.runPromise(runDeploy(fx(), { selection: sel, kitSha: "sha1", kitVersion: "1.0.0" }));
}

describe("computeDiff", () => {
  test("(a) added: nothing deployed, select skills -> all added", () => {
    seedSkill("x");
    seedSkill("y");
    const diff = computeDiff(targets, cat(), resolved({ skills: ["x", "y"] }));
    const added = diff.entries.filter((e) => e.change === "added").map((e) => e.name);
    expect(new Set(added)).toEqual(new Set(["x", "y"]));
    expect(diff.entries.every((e) => e.change === "added")).toBe(true);
  });

  test("(b) removed: ledger owns {a,b}, select {a} -> b removed", async () => {
    seedSkill("a");
    seedSkill("b");
    await deploy(resolved({ skills: ["a", "b"] }));

    const diff = computeDiff(targets, cat(), resolved({ skills: ["a"] }));
    const removed = diff.entries.filter((e) => e.change === "removed");
    expect(removed.map((e) => e.name)).toEqual(["b"]);
  });

  test("(c) changed-by-content: mutate the mirror source so the rendered hash differs", async () => {
    seedSkill("c", "original body");
    await deploy(resolved({ skills: ["c"] }));
    // Mutate the mirror source so a re-deploy WOULD write different bytes.
    seedSkill("c", "MUTATED body");

    const diff = computeDiff(targets, cat(), resolved({ skills: ["c"] }));
    const changed = diff.entries.find((e) => e.kind === "skill" && e.name === "c");
    expect(changed).toBeDefined();
    expect(changed?.change).toBe("changed");
  });

  test("(d) CLAUDE.md user-file warning: pre-place a non-Kit CLAUDE.md", () => {
    seedInstruction("core", "core body");
    // A user-authored CLAUDE.md exists, but the ledger has no instructions.
    mkdirSync(targets.claudeHome(), { recursive: true });
    writeFileSync(join(targets.claudeHome(), "CLAUDE.md"), "USER WROTE THIS");

    const diff = computeDiff(targets, cat(), resolved({ instructions: ["core"] }));
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
    const diff = computeDiff(targets, cat(), codexOnly);
    expect(diff.entries.filter((d) => d.kind === "skill")).toEqual([]);
  });

  test("(f) codex-only: an existing user AGENTS.md triggers the user-file warning", () => {
    seedInstruction("core", "core body");
    mkdirSync(targets.codexHome(), { recursive: true });
    writeFileSync(join(targets.codexHome(), "AGENTS.md"), "USER WROTE THIS CODEX FILE");
    const diff = computeDiff(
      targets,
      cat(),
      resolved({ instructions: ["core"], targets: ["codex"] }),
    );
    const instr = diff.entries.find((e) => e.kind === "instruction" && e.name === "core");
    expect(instr?.replacesUserFile).toBe(true);
  });
});
