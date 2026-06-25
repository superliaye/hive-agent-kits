// #35 close-hygiene — Source precedence + Shadowed-at-deploy provenance, plus the
// enforceable non-decision guard (Q6).
//
// (E.1) A cross-Source precedence deploy: two active git Sources provide the same
// skill key with DIFFERENT content so one wins and the other is shadowed. After a
// deploy, the fingerprint sidecar records winnerSourceId = the winning Source for
// that name, and the shadowed Variant is neither deployed nor fingerprinted.
//
// (E.3) The deliberate closure can't silently regress: FingerprintEntrySchema and
// FingerprintFileSchema carry NO content-fingerprint key.
//
// Hermetic: Mirrors written directly to disk (no sync, no network); redirected
// temp homes; the real engine deploys into them. mode-pure, no fs.watch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@hive/contract";
import { Effect } from "effect";
import { readCatalog } from "../catalog.ts";
import type { DeployFsExec, ExecPort } from "../deploy/adapter.ts";
import { runDeploy } from "../deploy/engine.ts";
import { FingerprintEntrySchema, FingerprintFileSchema, readFingerprints } from "../fingerprint.ts";
import { readLedger } from "../ledger.ts";
import { resolveSelection } from "../selection.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

let tmpRoot: string;
let targets: DeployTargets;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-prec-"));
  redirectHomeEnv(tmpRoot);
  targets = defaultDeployTargets();
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function gitSource(id: string, createdAt: number): Source {
  return { id, origin: `https://github.com/owner/${id}`, kind: "git", active: true, createdAt };
}

function writeSkillIn(mirrorRoot: string, name: string, body: string): void {
  const dir = join(mirrorRoot, "capabilities", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`);
}

const okExec: ExecPort = () => ({ status: 0, stdout: "", stderr: "" });
function fx(): DeployFsExec {
  return { targets, exec: okExec, probe: () => true };
}

describe("#35 — cross-Source precedence deploy provenance (E.1)", () => {
  test("fingerprint records winnerSourceId; shadowed Variant neither deployed nor recorded", async () => {
    const A = gitSource("src-a", 0);
    const B = gitSource("src-b", 1);
    const mirrorA = targets.mirrorRoot(A.id);
    const mirrorB = targets.mirrorRoot(B.id);
    // Same skill key `sk`, DIFFERENT content → B (later git) wins, A shadowed.
    writeSkillIn(mirrorA, "sk", "A BODY — the shadowed loser");
    writeSkillIn(mirrorB, "sk", "B BODY — the precedence winner");

    // Resolve the selection through the real catalog so the winner is computed by
    // Source precedence (not hand-supplied).
    const catalog = readCatalog(targets, [A, B]);
    const resolved = resolveSelection(catalog, {
      presets: [],
      add: { instructions: [], skills: ["sk"], agents: [], plugins: [], bundles: [] },
      remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
      targets: ["claude"],
    });
    // The resolved item carries B as the winner.
    expect(resolved.skills.length).toBe(1);
    expect(resolved.skills[0]?.sourceId).toBe("src-b");

    await Effect.runPromise(
      runDeploy(fx(), {
        selection: resolved,
        kitSha: null,
        kitVersion: "",
        activeMirrorRoots: [mirrorA, mirrorB],
      }),
    );

    // The deployed bytes are the WINNER's (B's body), never A's.
    const deployed = join(targets.claudeHome(), "skills", "sk", "SKILL.md");
    expect(existsSync(deployed)).toBe(true);
    const bytes = readFileSync(deployed, "utf8");
    expect(bytes).toContain("B BODY");
    expect(bytes).not.toContain("A BODY");

    // The sidecar records winnerSourceId = B for `sk`; exactly one entry for it.
    const fp = readFingerprints(targets);
    const skEntries = fp.entries.filter((e) => e.kind === "skill" && e.name === "sk");
    expect(skEntries.length).toBe(1);
    expect(skEntries[0]?.winnerSourceId).toBe("src-b");
    // The shadowed Variant (A) is neither deployed nor fingerprinted.
    expect(fp.entries.some((e) => e.winnerSourceId === "src-a")).toBe(false);

    // The ledger records the deployed name once (no shadow phantom).
    expect(readLedger(targets)?.skills.map((s) => s.name)).toEqual(["sk"]);
  });
});

describe("#35 — enforceable non-decision guard (E.3, Q6)", () => {
  test("FingerprintEntrySchema records no content fingerprint key", () => {
    const keys = Object.keys(FingerprintEntrySchema.shape);
    expect(keys).not.toContain("contentSha");
    expect(keys).not.toContain("contentHash");
    // The only `hash` is the drift hash of the deployed artifact — and it is the
    // sole hash-shaped key (no content-fingerprint sibling slipped in).
    expect(keys.filter((k) => k.toLowerCase().includes("hash"))).toEqual(["hash"]);
  });

  test("FingerprintFileSchema records no content fingerprint key", () => {
    const keys = Object.keys(FingerprintFileSchema.shape);
    expect(keys).not.toContain("contentSha");
    expect(keys).not.toContain("contentHash");
    expect(keys.sort()).toEqual(["entries", "version"]);
  });
});
