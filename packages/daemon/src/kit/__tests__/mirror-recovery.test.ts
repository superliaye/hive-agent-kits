// Regression: mirror crash-recovery + .prev backup sweep (review finding).
//
// writeMirror swaps in two renames (mirror -> .prev, stage -> mirror). A crash
// between them leaves the only copy under a `.prev-*` name and mirrorRoot gone.
// recoverMirror (run on startup) must restore the newest backup and sweep the rest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mirrorExists, recoverMirror } from "../mirror.ts";
import { type DeployTargets, failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SOURCE_ID = "src-1";

let tmpRoot: string;
let targets: DeployTargets;
let mirrorRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
  targets = failSafeDeployTargets();
  mirrorRoot = targets.mirrorRoot(SOURCE_ID);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Simulate a crash mid-swap: a good mirror was renamed to `.prev-<ts>` and the
// process died before stage->mirror, so mirrorRoot is absent.
function simulateCrashedSwap(): void {
  mkdirSync(mirrorRoot, { recursive: true });
  mkdirSync(join(mirrorRoot, "capabilities"), { recursive: true });
  writeFileSync(join(mirrorRoot, "capabilities", "marker"), "good");
  const backup = `${mirrorRoot}.prev-${Date.now()}`;
  renameSync(mirrorRoot, backup);
}

describe("recoverMirror", () => {
  test("restores the mirror from a .prev-* backup when mirrorRoot is missing", () => {
    simulateCrashedSwap();
    expect(mirrorExists(mirrorRoot)).toBe(false);

    recoverMirror(mirrorRoot);

    expect(mirrorExists(mirrorRoot)).toBe(true);
    expect(existsSync(join(mirrorRoot, "capabilities", "marker"))).toBe(true);
  });

  test("sweeps leftover .prev-* backups (no orphan accumulation)", () => {
    mkdirSync(join(mirrorRoot, "capabilities"), { recursive: true });
    // Two orphaned backups alongside a healthy mirror.
    mkdirSync(`${mirrorRoot}.prev-100`, { recursive: true });
    mkdirSync(`${mirrorRoot}.prev-200`, { recursive: true });

    recoverMirror(mirrorRoot);

    const parent = dirname(mirrorRoot);
    const base = mirrorRoot.split(/[\\/]/).pop() ?? "mirror";
    const leftover = readdirSync(parent).filter((e) => e.startsWith(`${base}.prev-`));
    expect(leftover).toEqual([]);
    expect(mirrorExists(mirrorRoot)).toBe(true);
  });
});
