import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Source } from "@hive/contract";
import { Cause, Effect, Exit } from "effect";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import { commitMirror, materialize, readMirrorIdentity, readMirrorRecord } from "../mirror.ts";
import { recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { syncLocatorSource } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, fakeGitProcess, memorySnapshot, redirectHomeEnv } from "./helpers.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-mirror-"));
  redirectHomeEnv(root);
});

afterEach(() => {
  delete process.env.HIVE_STARTER_ROOT;
  clearHomeEnv();
  rmSync(root, { recursive: true, force: true });
});

const starter: Source = {
  id: "starter",
  label: "Starter",
  locator: { kind: "starter" },
  origin: "local:starter",
  kind: "local",
  active: true,
  createdAt: 0,
  rank: 0,
};

function mirrorFiles(mirror: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(mirror, path)] = readFileSync(path, "utf8");
    }
  };
  walk(mirror);
  delete files[".hive-mirror.json"];
  return files;
}

describe("Mirror materialization", () => {
  test("re-syncing an unchanged tree keeps the identity and the bytes; exec bits survive", async () => {
    const kit = join(root, "starter-kit");
    const skill = join(kit, "capabilities", "skills", "alpha");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n");
    writeFileSync(join(skill, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(skill, "run.sh"), 0o755);
    writeFileSync(join(kit, "README.md"), "not ingested\n");
    process.env.HIVE_STARTER_ROOT = kit;
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot(starter.id);

    const first = await Effect.runPromise(syncLocatorSource(starter, targets));
    const identity = readMirrorIdentity(mirror);
    const bytes = mirrorFiles(mirror);
    const second = await Effect.runPromise(syncLocatorSource(starter, targets));

    expect(first.status).toBe("synced");
    expect(second.status).toBe("unchanged");
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(readMirrorIdentity(mirror)).toBe(identity);
    expect(mirrorFiles(mirror)).toEqual(bytes);
    expect(Object.keys(bytes).sort()).toEqual([
      "capabilities/skills/alpha/SKILL.md",
      "capabilities/skills/alpha/run.sh",
    ]);
    expect(lstatSync(join(mirror, "capabilities/skills/alpha/run.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(mirror, "capabilities/skills/alpha/SKILL.md")).mode & 0o777).toBe(0o644);
    expect(readMirrorRecord(mirror)).toMatchObject({
      origin: { transport: "bundled" },
      recipe: { id: "capability-kit", label: "Capability kit", unit: "pick" },
    });

    chmodSync(join(skill, "run.sh"), 0o644);
    expect((await Effect.runPromise(syncLocatorSource(starter, targets))).status).toBe("synced");
    expect(readMirrorIdentity(mirror)).not.toBe(identity);
  });

  test("the identity moves when the projection moves even though the tree did not", async () => {
    const { snapshot } = memorySnapshot({
      "capabilities/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\n",
      "presets/day.yaml": "name: day\n",
    });
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");
    const recognition = await Effect.runPromise(recognizeSource(recipeTree(snapshot)));
    const commit = (projected: typeof recognition) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const staged = yield* materialize(
              snapshot,
              projected,
              targets.kitTmpRoot(),
              DEFAULT_TREE_LIMITS,
            );
            return yield* commitMirror(mirror, staged);
          }),
        ),
      );

    await commit(recognition);
    const full = readMirrorIdentity(mirror);
    await commit({
      ...recognition,
      projection: { ...recognition.projection, copies: recognition.projection.copies.slice(0, 1) },
    });
    const narrowed = readMirrorIdentity(mirror);
    await commit({ ...recognition, recipe: { ...recognition.recipe, unit: "whole" } });

    expect(narrowed).not.toBe(full);
    expect(readMirrorIdentity(mirror)).not.toBe(full);
    expect(readMirrorIdentity(mirror)).not.toBe(narrowed);
    expect(existsSync(join(mirror, "presets"))).toBe(true);
    expect(readdirSync(targets.kitTmpRoot())).toEqual([]);
  });

  test("links into the tree become files; links to directories or out of the tree are dropped", async () => {
    const { snapshot } = memorySnapshot({
      "capabilities/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\n",
      "capabilities/skills/alpha/tool": { exec: "#!/bin/sh\n" },
      "capabilities/skills/alpha/tool-link": { link: "tool" },
      "capabilities/skills/current": { link: "alpha" },
      "capabilities/skills/alpha/escape": { link: "../../../../outside" },
    });
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("source-a");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const recognition = yield* recognizeSource(recipeTree(snapshot));
          const staged = yield* materialize(
            snapshot,
            recognition,
            targets.kitTmpRoot(),
            DEFAULT_TREE_LIMITS,
          );
          return yield* commitMirror(mirror, staged);
        }),
      ),
    );

    const link = join(mirror, "capabilities/skills/alpha/tool-link");
    expect(lstatSync(link).isFile()).toBe(true);
    expect(lstatSync(link).mode & 0o777).toBe(0o755);
    expect(readFileSync(link, "utf8")).toBe("#!/bin/sh\n");
    expect(existsSync(join(mirror, "capabilities/skills/current"))).toBe(false);
    expect(existsSync(join(mirror, "capabilities/skills/alpha/escape"))).toBe(false);
  });

  test("a git listing far over the limits ingests only capabilities/ and presets/", async () => {
    const outside = Array.from({ length: DEFAULT_TREE_LIMITS.maxFiles + 5_000 }, (_, index) => ({
      path: `vendor/${Math.floor(index / 1000)}/file-${index}.txt`,
      content: "x",
    }));
    const { process: gitProcess, batched } = fakeGitProcess([
      ...outside,
      {
        path: "capabilities/skills/alpha/SKILL.md",
        content: "---\nname: alpha\ndescription: a\n---\n",
      },
      { path: "capabilities/skills/alpha/run.sh", content: "#!/bin/sh\n", mode: "100755" },
      { path: "presets/day.yaml", content: "name: day\n" },
    ]);
    const source: Source = {
      id: "git-a",
      label: "git-a",
      locator: {
        kind: "git",
        repoUrl: "https://example.invalid/acme/kit",
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
      origin: "https://example.invalid/acme/kit",
      kind: "git",
      active: true,
      createdAt: 0,
      rank: 0,
    };
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot(source.id);

    expect(
      (await Effect.runPromise(syncLocatorSource(source, targets, { gitProcess }))).status,
    ).toBe("synced");

    expect(Object.keys(mirrorFiles(mirror)).sort()).toEqual([
      "capabilities/skills/alpha/SKILL.md",
      "capabilities/skills/alpha/run.sh",
      "presets/day.yaml",
    ]);
    expect(batched).toHaveLength(3);
    expect(lstatSync(join(mirror, "capabilities/skills/alpha/run.sh")).mode & 0o777).toBe(0o755);
    expect(readMirrorRecord(mirror)?.origin).toMatchObject({
      transport: "git",
      resolvedCommit: "a".repeat(40),
      subpath: ".",
    });
  });

  test("the file limit counts the ingested set", async () => {
    const { snapshot } = memorySnapshot({
      "capabilities/skills/alpha/SKILL.md": "a",
      "capabilities/skills/alpha/extra.md": "b",
    });
    const targets = failSafeDeployTargets();

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const recognition = yield* recognizeSource(recipeTree(snapshot));
          return yield* materialize(snapshot, recognition, targets.kitTmpRoot(), {
            ...DEFAULT_TREE_LIMITS,
            maxFiles: 1,
          });
        }),
      ),
    );

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      reason: "budget_exceeded",
    });
    expect(existsSync(targets.mirrorRoot("source-a"))).toBe(false);
  });
});
