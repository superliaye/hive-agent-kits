import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, Selection, Source } from "@hive/contract";
import { Effect } from "effect";
import { readCatalog } from "../catalog.ts";
import type { DeployFsExec } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { DeployError } from "../effect/errors.ts";
import { catalogNameSets, computeDiff, resolveSelection } from "../selection.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;
let targets: DeployTargets;

function src(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    origin: `https://github.com/owner/${id}`,
    kind: "git",
    active: true,
    createdAt: 0,
    ...over,
  };
}

const SRC_A = src("src-a");
const SRC_B = src("src-b");

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-sel-"));
  redirectHomeEnv(tmpRoot);
  targets = defaultDeployTargets();
  for (const s of [SRC_A, SRC_B]) {
    mkdirSync(join(targets.mirrorRoot(s.id), "capabilities"), { recursive: true });
  }
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSkillIn(sourceId: string, name: string, body: string): void {
  const dir = join(targets.mirrorRoot(sourceId), "capabilities", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\ndescription: s\n---\n${body}\n`);
}

function writeInstructionIn(sourceId: string, name: string, body: string): void {
  const dir = join(targets.mirrorRoot(sourceId), "capabilities", "instructions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.instructions.md`), `---\ndescription: ${name}\n---\n${body}\n`);
}

function selection(over: Partial<Selection["add"]>): Selection {
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

const fx = (): DeployFsExec => ({
  targets,
  exec: () => ({ status: 0, stdout: "", stderr: "" }),
  probe: () => true,
});

// The per-kind active-catalog name arrays a deploy threads into reconcilePrune
// (#47), derived from a catalog the same way kit-live does.
function deployActiveNames(cat: Catalog): { skills: readonly string[]; agents: readonly string[] } {
  const sets = catalogNameSets(cat);
  return { skills: [...sets.skills], agents: [...sets.agents] };
}

describe("resolveSelection — winner resolution", () => {
  test("cross-Source collision resolves to the WINNER's sourceId, never the shadow, no throw", () => {
    writeSkillIn(SRC_A.id, "foo", "body A");
    writeSkillIn(SRC_B.id, "foo", "body B"); // src-b wins (later git)
    const cat = readCatalog(targets, [SRC_A, SRC_B]);
    const resolved = resolveSelection(cat, selection({ skills: ["foo"] }));
    expect(resolved.skills).toEqual([{ name: "foo", sourceId: "src-b" }]);
  });

  test("a MERGE resolves to one item (the winner provider)", () => {
    writeSkillIn(SRC_A.id, "foo", "same");
    writeSkillIn(SRC_B.id, "foo", "same");
    const cat = readCatalog(targets, [SRC_A, SRC_B]);
    const resolved = resolveSelection(cat, selection({ skills: ["foo"] }));
    expect(resolved.skills.length).toBe(1);
    expect(resolved.skills[0]?.sourceId).toBe("src-b");
  });

  test("a single-Source malformed key (no deployable variant) still throws DeployError(collision)", () => {
    writeSkillIn(SRC_A.id, "@x/foo", "a");
    writeSkillIn(SRC_A.id, "@y/foo", "b");
    const cat = readCatalog(targets, [SRC_A]);
    let thrown: unknown;
    try {
      resolveSelection(cat, selection({ skills: ["foo"] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DeployError);
    expect((thrown as DeployError).reason).toBe("collision");
  });

  test("a phantom name no Source provides is dropped (not thrown, not in the plan)", () => {
    writeSkillIn(SRC_A.id, "real", "x");
    const cat = readCatalog(targets, [SRC_A]);
    const resolved = resolveSelection(cat, selection({ skills: ["ghost"] }));
    expect(resolved.skills).toEqual([]);
  });
});

describe("computeDiff — orphan keep + split-winner instruction", () => {
  test("#47: a ledger-owned orphan (no active-catalog entry) is KEPT, not removed", async () => {
    // Deploy `keep` + `gone` while both are provided by an active Source so the
    // ledger owns both.
    writeSkillIn(SRC_A.id, "keep", "k");
    writeSkillIn(SRC_A.id, "gone", "g");
    const cat1 = readCatalog(targets, [SRC_A]);
    await Effect.runPromise(
      runDeploy(fx(), {
        selection: resolveSelection(cat1, selection({ skills: ["keep", "gone"] })),
        kitSha: null,
        kitVersion: "",
        activeMirrorRoots: [targets.mirrorRoot(SRC_A.id)],
        activeCatalogNames: deployActiveNames(cat1),
      }),
    );
    // Now `gone`'s Source is gone from the active catalog (drop its Mirror source).
    rmSync(join(targets.mirrorRoot(SRC_A.id), "capabilities", "skills", "gone"), {
      recursive: true,
      force: true,
    });
    // Re-resolve a selection that selects only `keep`; `gone` is owned-but-absent
    // from the active catalog → an ORPHAN, kept (no removed entry), never deleted.
    const cat2 = readCatalog(targets, [SRC_A]);
    const resolved = resolveSelection(cat2, selection({ skills: ["keep"] }));
    const diff = computeDiff(
      targets,
      [targets.mirrorRoot(SRC_A.id)],
      resolved,
      catalogNameSets(cat2),
    );
    expect(diff.entries.some((e) => e.name === "gone")).toBe(false);
  });

  test("instruction split-winner: two instructions won by different Sources; changing one diffs changed", async () => {
    // core won by A, extra won by B (each provided by only one Source → that
    // Source wins). Deploy both, then mutate A's `core` body → the concatenated
    // whole-file must diff `changed`, proving each instruction hashes against its
    // own winner Mirror.
    writeInstructionIn(SRC_A.id, "core", "core v1");
    writeInstructionIn(SRC_B.id, "extra", "extra v1");
    const cat1 = readCatalog(targets, [SRC_A, SRC_B]);
    const activeRoots = [targets.mirrorRoot(SRC_A.id), targets.mirrorRoot(SRC_B.id)];
    await Effect.runPromise(
      runDeploy(fx(), {
        selection: resolveSelection(cat1, selection({ instructions: ["core", "extra"] })),
        kitSha: null,
        kitVersion: "",
        activeMirrorRoots: activeRoots,
        activeCatalogNames: deployActiveNames(cat1),
      }),
    );
    // Mutate A's core body.
    writeInstructionIn(SRC_A.id, "core", "core v2 CHANGED");
    const cat2 = readCatalog(targets, [SRC_A, SRC_B]);
    const resolved = resolveSelection(cat2, selection({ instructions: ["core", "extra"] }));
    const diff = computeDiff(targets, activeRoots, resolved, catalogNameSets(cat2));
    expect(diff.entries.some((e) => e.kind === "instruction" && e.change === "changed")).toBe(true);
  });
});
