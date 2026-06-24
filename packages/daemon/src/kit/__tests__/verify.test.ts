// Verify pass + integrity fingerprint (Feature 1 + Feature 2).
//
// Deploys through the REAL engine into a redirected temp home (so the real
// ~/.claude is never touched), then asserts the on-disk self-check reports
// present/missing/drifted/recorded and that the fingerprint sidecar is
// Hive-private and prunes in lockstep with the ledger.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyEntry } from "@hive/contract";
import { Effect } from "effect";
import type { DeployFsExec, ExecPort } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { readFingerprints } from "../fingerprint.ts";
import { emptyLedger, type Ledger, readLedger } from "../ledger.ts";
import type { ResolvedSelection } from "../selection.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import { runVerify } from "../verify.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SOURCE_ID = "src-1";

let tmpRoot: string;
let targets: DeployTargets;
let mirror: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-verify-"));
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

type NameOver = {
  instructions?: string[];
  skills?: string[];
  agents?: string[];
  plugins?: string[];
  bundles?: string[];
  targets?: ("claude" | "codex")[];
};

function resolved(over: NameOver): ResolvedSelection {
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

const okExec: ExecPort = () => ({ status: 0, stdout: "", stderr: "" });
function fx(): DeployFsExec {
  return { targets, exec: okExec, probe: () => true };
}

async function deploy(sel: NameOver): Promise<void> {
  await Effect.runPromise(
    runDeploy(fx(), {
      selection: resolved(sel),
      kitSha: "sha1",
      kitVersion: "1.0.0",
      activeMirrorRoots: [mirror],
    }),
  );
}

function entryFor(entries: VerifyEntry[], name: string): VerifyEntry | undefined {
  return entries.find((e) => e.name === name);
}
function statusOn(entry: VerifyEntry | undefined, target: "claude" | "codex"): string | undefined {
  return entry?.targets.find((t) => t.target === target)?.status;
}

describe("verify — on-disk existence (Feature 1)", () => {
  test("deployed skill reports present; deleting its dir reports missing", async () => {
    seedSkill("alpha");
    await deploy({ skills: ["alpha"], targets: ["claude"] });

    let report = runVerify(targets);
    expect(statusOn(entryFor(report.entries, "alpha"), "claude")).toBe("present");

    rmSync(join(targets.claudeHome(), "skills", "alpha"), { recursive: true, force: true });
    report = runVerify(targets);
    expect(statusOn(entryFor(report.entries, "alpha"), "claude")).toBe("missing");
  });

  test("path-resolution matches deploy: both homes checked; claude-only not missing for codex", async () => {
    seedSkill("dual");
    await deploy({ skills: ["dual"], targets: ["claude", "codex"] });
    const both = runVerify(targets);
    const dual = entryFor(both.entries, "dual");
    expect(statusOn(dual, "claude")).toBe("present");
    expect(statusOn(dual, "codex")).toBe("present");

    // Fresh home, claude-only deploy: codex must NOT appear / must not be missing.
    clearHomeEnv();
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = mkdtempSync(join(tmpdir(), "kit-verify-"));
    redirectHomeEnv(tmpRoot);
    targets = defaultDeployTargets();
    mirror = targets.mirrorRoot(SOURCE_ID);
    mkdirSync(mirror, { recursive: true });
    seedSkill("solo");
    await deploy({ skills: ["solo"], targets: ["claude"] });
    const solo = entryFor(runVerify(targets).entries, "solo");
    expect(solo?.targets.map((t) => t.target)).toEqual(["claude"]);
    expect(statusOn(solo, "claude")).toBe("present");
  });

  test("plugin/bundle report recorded (never present/missing)", () => {
    // Write a ledger directly with a plugin + bundle (installer-owned kinds).
    const ledger: Ledger = {
      ...emptyLedger(),
      agents: ["claude"],
      plugins: [{ name: "myplug" }],
      bundles: [{ name: "mybundle", pin: null }],
    };
    mkdirSync(join(tmpRoot, "ledger"), { recursive: true });
    writeFileSync(targets.ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);

    const report = runVerify(targets);
    expect(statusOn(entryFor(report.entries, "myplug"), "claude")).toBe("recorded");
    expect(statusOn(entryFor(report.entries, "mybundle"), "claude")).toBe("recorded");
  });

  test("verify is read-only: never writes a ledger or fingerprint file", () => {
    // No deploy, no ledger → empty report, no files created.
    const report = runVerify(targets);
    expect(report.entries).toEqual([]);
    expect(existsSync(targets.ledgerPath())).toBe(false);
    expect(existsSync(targets.fingerprintPath())).toBe(false);
  });
});

describe("verify — drift detection (Feature 2)", () => {
  test("editing a deployed skill byte makes verify report drifted; unedited stays present", async () => {
    seedSkill("edit");
    await deploy({ skills: ["edit"], targets: ["claude"] });
    expect(statusOn(entryFor(runVerify(targets).entries, "edit"), "claude")).toBe("present");

    const deployedSkill = join(targets.claudeHome(), "skills", "edit", "SKILL.md");
    const cur = readFileSync(deployedSkill, "utf8");
    writeFileSync(deployedSkill, `${cur} edited`);
    expect(statusOn(entryFor(runVerify(targets).entries, "edit"), "claude")).toBe("drifted");
  });

  test("a deployed capability with NO fingerprint stays present (no false alarm)", async () => {
    seedSkill("nofp");
    await deploy({ skills: ["nofp"], targets: ["claude"] });
    // Drop the fingerprint sidecar entirely (simulates a pre-fingerprint deploy).
    rmSync(targets.fingerprintPath(), { force: true });
    expect(statusOn(entryFor(runVerify(targets).entries, "nofp"), "claude")).toBe("present");
  });

  test("deselecting one of several instructions does NOT false-alarm the survivor as drifted", async () => {
    // The whole CLAUDE.md is a concatenation; instructions are never pruned from
    // the ledger. Redeploying a subset rewrites the file — the single target-
    // scoped instruction fingerprint must track the fresh whole-file, so the
    // surviving (still-ledgered) instruction name verifies as present, not drifted.
    seedInstruction("core", "core body");
    seedInstruction("extra", "extra body");
    await deploy({ instructions: ["core", "extra"], targets: ["claude"] });
    let report = runVerify(targets);
    expect(statusOn(entryFor(report.entries, "core"), "claude")).toBe("present");
    expect(statusOn(entryFor(report.entries, "extra"), "claude")).toBe("present");

    // Redeploy with only core: CLAUDE.md is rewritten to core-only; the ledger
    // still lists both names (instructions never prune). Neither must drift.
    await deploy({ instructions: ["core"], targets: ["claude"] });
    report = runVerify(targets);
    expect(statusOn(entryFor(report.entries, "core"), "claude")).toBe("present");
    expect(statusOn(entryFor(report.entries, "extra"), "claude")).toBe("present");
  });
});

describe("fingerprint sidecar — Hive-private + lockstep prune (Feature 2)", () => {
  test("sidecar lives under the Hive home; ledger keeps its EXACT schema (no added keys)", async () => {
    seedSkill("priv");
    await deploy({ skills: ["priv"], targets: ["claude"] });

    // Sidecar is under the Hive runtime home, NOT next to / inside the ledger dir.
    const fpPath = targets.fingerprintPath();
    expect(existsSync(fpPath)).toBe(true);
    expect(fpPath.replace(/\\/g, "/")).toContain("/runtime/kit/");
    expect(fpPath.replace(/\\/g, "/")).not.toContain("/ledger/");

    // Ledger round-trips with exactly its schema keys — no fingerprint/hash field.
    const raw = JSON.parse(readFileSync(targets.ledgerPath(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ["agentDefs", "agents", "bundles", "instructions", "kitVersion", "plugins", "skills"].sort(),
    );
  });

  test("sidecar is version 2; skill/agent carry winnerSourceId; instruction sentinel carries none", async () => {
    seedSkill("sk");
    seedInstruction("core", "core body");
    await deploy({ skills: ["sk"], instructions: ["core"], targets: ["claude"] });

    // Raw sidecar JSON: version 2.
    const raw = JSON.parse(readFileSync(targets.fingerprintPath(), "utf8")) as {
      version: number;
    };
    expect(raw.version).toBe(2);

    const fp = readFingerprints(targets);
    const skill = fp.entries.find((e) => e.kind === "skill" && e.name === "sk");
    expect(skill?.winnerSourceId).toBe(SOURCE_ID);
    const instr = fp.entries.find((e) => e.kind === "instruction");
    expect(instr).toBeDefined();
    expect(instr?.winnerSourceId).toBeUndefined();
  });

  test("an on-disk v1 sidecar is read as empty (discarded); verify reports present (no false drift)", async () => {
    seedSkill("legacy");
    await deploy({ skills: ["legacy"], targets: ["claude"] });
    // Overwrite the sidecar with a v1 shape (the pre-bump schema). It must be
    // discarded on read → verify falls back to present (no recorded hash → no drift).
    writeFileSync(
      targets.fingerprintPath(),
      `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
    );
    expect(readFingerprints(targets).entries).toEqual([]);
    expect(statusOn(entryFor(runVerify(targets).entries, "legacy"), "claude")).toBe("present");
  });

  test("only landed items fingerprinted; redeploy {a} after {a,b} prunes b in lockstep", async () => {
    seedSkill("a");
    seedSkill("b");
    await deploy({ skills: ["a", "b"], targets: ["claude"] });
    let fp = readFingerprints(targets);
    expect(fp.entries.map((e) => e.name).sort()).toEqual(["a", "b"]);

    // Redeploy with only {a}: the engine prunes b from the ledger; the sidecar
    // must drop b's fingerprint in lockstep.
    await deploy({ skills: ["a"], targets: ["claude"] });
    fp = readFingerprints(targets);
    expect(fp.entries.map((e) => e.name)).toEqual(["a"]);
    expect(readLedger(targets)?.skills.map((e) => e.name)).toEqual(["a"]);
  });
});
