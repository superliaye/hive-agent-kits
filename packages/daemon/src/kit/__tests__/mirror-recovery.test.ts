// Regression: mirror crash-recovery + .prev backup sweep (regression).
//
// commitMirror swaps in two renames (mirror -> .prev, stage -> mirror). A crash
// between them leaves the only copy under a `.prev-*` name and mirrorRoot gone.
// recoverMirror (run on startup) must restore the newest backup and sweep the rest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import { commitMirror, materialize, recoverMirror, sweepStaleTmp } from "../mirror.ts";
import { recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { type DeployTargets, failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, memorySnapshot, redirectHomeEnv } from "./helpers.ts";

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

const mirrorExists = (root: string) => existsSync(join(root, "capabilities"));

function syncKit(marker: string): Promise<unknown> {
  const { snapshot } = memorySnapshot({ "capabilities/marker": marker });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recognition = yield* recognizeSource(recipeTree(snapshot, DEFAULT_TREE_LIMITS));
        const staged = yield* materialize(
          snapshot,
          recognition,
          targets.kitTmpRoot(),
          DEFAULT_TREE_LIMITS,
        );
        return yield* commitMirror(mirrorRoot, staged);
      }),
    ),
  );
}

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

  test("a Source sync never sweeps another acquisition's active temp directory", async () => {
    const active = join(targets.kitTmpRoot(), "extract-working-tree-active");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "owned"), "still active");

    await syncKit("new");

    expect(existsSync(join(active, "owned"))).toBe(true);
  });

  test("startup cleanup preserves another live Daemon's stage and removes abandoned remnants", async () => {
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const live = join(targets.kitTmpRoot(), `extract-owner-${owner.pid}-active`);
    const legacy = join(targets.kitTmpRoot(), "extract-legacy-abandoned");
    const malformed = join(targets.kitTmpRoot(), "extract-owner-not-a-pid");
    mkdirSync(live, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    mkdirSync(malformed, { recursive: true });

    try {
      sweepStaleTmp(targets.kitTmpRoot());

      expect(existsSync(live)).toBe(true);
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(malformed)).toBe(false);
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
    }
  });

  test("a commit replaces the prior Mirror and leaves no backup behind", async () => {
    await syncKit("old");
    await syncKit("new");

    expect(readFileSync(join(mirrorRoot, "capabilities", "marker"), "utf8")).toBe("new");
    expect(readdirSync(dirname(mirrorRoot)).some((entry) => entry.includes(".prev-"))).toBe(false);
  });
});
