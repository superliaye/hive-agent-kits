import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  emptyLedger,
  type Ledger,
  LedgerSchema,
  mergeLedger,
  ownedNamesSnapshot,
  readLedger,
  reconcilePrune,
} from "../ledger.ts";
import { defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeLedgerFile(ledger: Ledger): void {
  const p = defaultDeployTargets().ledgerPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`);
}

describe("ledger", () => {
  test("(a) round-trip: mergeLedger writes a LedgerSchema-valid file with exact keys", () => {
    const targets = defaultDeployTargets();
    const written = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["s1", "s2"],
        agents: ["a1"],
        instructions: ["core"],
        plugins: ["p1"],
        bundles: [{ name: "b1", pin: "deadbeef" }],
      },
      [],
      [],
    );

    const onDisk = JSON.parse(readFileSync(targets.ledgerPath(), "utf8"));
    const parsed = LedgerSchema.parse(onDisk);

    expect(Object.keys(parsed).sort()).toEqual(
      ["agentDefs", "agents", "bundles", "instructions", "kitVersion", "plugins", "skills"].sort(),
    );
    expect(parsed.kitVersion).toBe("1.0.0");
    expect(parsed.skills.map((e) => e.name).sort()).toEqual(["s1", "s2"]);
    expect(parsed.agentDefs.map((e) => e.name)).toEqual(["a1"]);
    expect(parsed.instructions.map((e) => e.name)).toEqual(["core"]);
    expect(parsed.plugins.map((e) => e.name)).toEqual(["p1"]);
    expect(parsed.bundles).toEqual([{ name: "b1", pin: "deadbeef" }]);
    expect(written).toEqual(parsed);
  });

  test("(b) pre-existing manifest surfaced by readLedger", () => {
    const targets = defaultDeployTargets();
    const seed: Ledger = {
      ...emptyLedger(),
      kitVersion: "0.9.0",
      skills: [{ name: "existing" }],
      bundles: [{ name: "bun", pin: null }],
    };
    writeLedgerFile(seed);
    const read = readLedger(targets);
    expect(read).not.toBeNull();
    expect(read?.kitVersion).toBe("0.9.0");
    expect(read?.skills.map((e) => e.name)).toEqual(["existing"]);
    expect(read?.bundles).toEqual([{ name: "bun", pin: null }]);
  });

  test("(c) prune-correctness: mergeLedger drops only pruned names", () => {
    const targets = defaultDeployTargets();
    writeLedgerFile({ ...emptyLedger(), skills: [{ name: "keep" }, { name: "drop" }] });

    const merged = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["keep"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      ["drop"], // prunedSkills
      [],
    );
    expect(merged.skills.map((e) => e.name).sort()).toEqual(["keep"]);
  });

  test("(d) concurrent external write: reconcilePrune re-reads -> X handled per fresh-ledger semantics", () => {
    const targets = defaultDeployTargets();
    // Hive deploys skill A.
    mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    // Snapshot what Hive owns at request start — the only names this deploy may
    // prune. (The engine takes this snapshot BEFORE applying.)
    const priorOwned = ownedNamesSnapshot(targets);
    expect(priorOwned.skills).toEqual(["A"]);

    // The agent-kit CLI concurrently adds skill X to the on-disk ledger.
    const current = readLedger(targets);
    expect(current).not.toBeNull();
    if (current) {
      writeLedgerFile({ ...current, skills: [...current.skills, { name: "X" }] });
    }

    // reconcilePrune re-reads the FRESH on-disk ledger {A, X} but prunes only
    // names that were Hive-owned at request start AND are now deselected. The new
    // deploy still selects {A}, so NOTHING is prunable — crucially X (the CLI's
    // concurrent addition) is NEVER returned, because it was not in priorOwned.
    const orphan = reconcilePrune(targets, ["A"], [], priorOwned);
    expect(orphan.skills).not.toContain("X");
    expect(orphan.skills).not.toContain("A");
    expect(orphan.skills).toEqual([]);

    // The deploy passes orphan.skills (empty) as pruned -> X survives the merge.
    const merged = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      orphan.skills,
      orphan.agents,
    );
    expect(merged.skills.map((e) => e.name).sort()).toEqual(["A", "X"]);
  });

  test("(d2) reconcilePrune DOES prune a Hive-owned skill that this deploy deselects", () => {
    const targets = defaultDeployTargets();
    // Hive owns {A, B} at request start.
    mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: ["A", "B"],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    const priorOwned = ownedNamesSnapshot(targets);
    // The new deploy selects only {A} -> B is the genuine owned-but-deselected orphan.
    const orphan = reconcilePrune(targets, ["A"], [], priorOwned);
    expect(orphan.skills).toEqual(["B"]);
  });

  test("(e) plugins/bundles never auto-removed on deselect (no prune path)", () => {
    const targets = defaultDeployTargets();
    writeLedgerFile({
      ...emptyLedger(),
      plugins: [{ name: "oldplugin" }],
      bundles: [{ name: "oldbundle", pin: "abc" }],
    });

    // A deploy that selects neither the old plugin nor the old bundle.
    const merged = mergeLedger(
      targets,
      {
        kitVersion: "1.0.0",
        targets: ["claude"],
        skills: [],
        agents: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
      [],
      [],
    );
    // Both survive — mergeLedger has no prune set for plugins/bundles.
    expect(merged.plugins.map((e) => e.name)).toContain("oldplugin");
    expect(merged.bundles.map((e) => e.name)).toContain("oldbundle");
  });
});
