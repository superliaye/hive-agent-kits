import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Source, SourceLocator } from "@hive/contract";
import { Effect } from "effect";
import { type GitProcess, GitProcessFailure } from "../acquisition/git-process.ts";
import { DEFAULT_TREE_LIMITS, type TreeLimits } from "../acquisition/tree-guard.ts";
import {
  canonicalizeWorkingTreeLocator,
  WorkingTreeAcquireError,
  workingTreeSnapshot,
} from "../acquisition/working-tree.ts";
import type { SyncError } from "../effect/errors.ts";
import { commitMirror, type MirrorRecord, materialize, readMirrorRecord } from "../mirror.ts";
import { recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { syncLocatorSource } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const roots: string[] = [];
type WorkingTreeLocator = Extract<SourceLocator, { kind: "working-tree" }>;

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function gitResult(stdout = "") {
  return { exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: "" };
}

function localGitProcess(
  beforeRun?: (args: readonly string[]) => Promise<void> | void,
): GitProcess {
  const run: GitProcess["run"] = async (args, options) => {
    await beforeRun?.(args);
    const result = Bun.spawnSync(["git", ...args], {
      cwd: options?.cwd,
      env: options?.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr.toString(),
    };
    if (result.exitCode !== 0) throw new GitProcessFailure(args, output, false);
    return output;
  };
  return { run };
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-working-tree-"));
  roots.push(root);
  runGit(root, "init", "-b", "main");
  runGit(root, "config", "user.email", "hive@example.invalid");
  runGit(root, "config", "user.name", "Hive Test");
  const skills = join(root, "nested", "kit", "capabilities", "skills");
  mkdirSync(join(skills, "tracked"), { recursive: true });
  writeFileSync(
    join(skills, "tracked", "SKILL.md"),
    "---\nname: tracked\ndescription: tracked\n---\nbody\n",
  );
  chmodSync(join(skills, "tracked", "SKILL.md"), 0o755);
  writeFileSync(join(skills, "tracked", "bytes.bin"), Buffer.from([0, 255, 17, 128]));
  writeFileSync(join(root, ".gitignore"), "ignored.txt\nnested/kit/capabilities/skills/ignored/\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", "tracked kit");
  mkdirSync(join(skills, "untracked"), { recursive: true });
  writeFileSync(
    join(skills, "untracked", "SKILL.md"),
    "---\nname: untracked\ndescription: untracked\n---\nbody\n",
  );
  mkdirSync(join(skills, "ignored"), { recursive: true });
  writeFileSync(join(skills, "ignored", "SKILL.md"), "ignored\n");
  writeFileSync(join(root, "ignored.txt"), "ignored\n");
  return root;
}

function workRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-working-stage-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "hive-working-home-"));
  roots.push(home);
  redirectHomeEnv(home);
});

afterEach(() => {
  clearHomeEnv();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Syncs the working tree as Source `id` through the real Sync path and returns
// the Mirror it committed.
async function syncWorkingTree(
  locator: WorkingTreeLocator,
  id: string,
  options: { allowedRoots: readonly string[]; process?: GitProcess },
): Promise<{ mirror: string; record: MirrorRecord | null }> {
  const source: Source = {
    id,
    label: id,
    locator,
    origin: "local:working-tree",
    kind: "local",
    active: true,
    createdAt: 0,
    rank: 0,
  };
  const targets = failSafeDeployTargets();
  await Effect.runPromise(
    syncLocatorSource(source, targets, {
      workingTreeRoots: options.allowedRoots,
      ...(options.process ? { gitProcess: options.process } : {}),
    }),
  );
  const mirror = targets.mirrorRoot(id);
  return { mirror, record: readMirrorRecord(mirror) };
}

// One capture with explicit limits: no retry, so a budget failure surfaces.
function captureWithLimits(
  locator: WorkingTreeLocator,
  allowedRoots: readonly string[],
  limits: TreeLimits,
  process?: GitProcess,
): Promise<unknown> {
  const targets = failSafeDeployTargets();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* workingTreeSnapshot(locator, {
          allowedRoots,
          limits,
          ...(process ? { process } : {}),
        });
        const recognition = yield* recognizeSource(recipeTree(snapshot, limits));
        const staged = yield* materialize(snapshot, recognition, targets.kitTmpRoot(), limits);
        yield* snapshot.confirm();
        return yield* commitMirror(targets.mirrorRoot("limited"), staged);
      }),
    ),
  );
}

async function expectReason(work: () => Promise<unknown>, reason: SyncError["reason"]) {
  await expect(work()).rejects.toMatchObject({ reason });
}

describe("working-tree Source acquisition", () => {
  test("snapshots tracked and non-ignored untracked files below the selected subpath", async () => {
    const repo = repository();

    const { mirror, record } = await syncWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      "wt",
      { allowedRoots: [repo] },
    );

    expect(
      readFileSync(join(mirror, "capabilities", "skills", "tracked", "SKILL.md"), "utf8"),
    ).toContain("name: tracked");
    expect(
      readFileSync(join(mirror, "capabilities", "skills", "untracked", "SKILL.md"), "utf8"),
    ).toContain("name: untracked");
    expect(existsSync(join(mirror, "capabilities", "skills", "ignored"))).toBe(false);
    expect(existsSync(join(mirror, "nested"))).toBe(false);
    expect(existsSync(join(mirror, "ignored.txt"))).toBe(false);
    expect(record?.origin).toMatchObject({
      transport: "working-tree",
      subpath: "nested/kit",
      dirty: true,
    });
  });

  test("treats a stable tracked deletion as absent content", async () => {
    const repo = repository();
    const deleted = join(repo, "nested", "kit", "capabilities", "skills", "tracked", "bytes.bin");
    rmSync(deleted);

    const { mirror, record } = await syncWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      "wt",
      { allowedRoots: [repo] },
    );

    expect(existsSync(join(mirror, "capabilities", "skills", "tracked", "bytes.bin"))).toBe(false);
    expect(record?.origin).toMatchObject({ dirty: true });
  });

  test("retries when a tracked file is present except during deleted-path enumeration", async () => {
    const repo = repository();
    const source = join(repo, "nested", "kit", "capabilities", "skills", "tracked", "bytes.bin");
    const held = `${source}.held`;
    const local = localGitProcess();
    let injected = false;
    const process: GitProcess = {
      run: async (args, options) => {
        if (!injected && args.includes("--deleted")) {
          injected = true;
          renameSync(source, held);
          try {
            return await local.run(args, options);
          } finally {
            renameSync(held, source);
          }
        }
        return local.run(args, options);
      },
    };

    const { mirror } = await syncWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      "wt",
      { allowedRoots: [repo], process },
    );

    expect(existsSync(join(mirror, "capabilities", "skills", "tracked", "bytes.bin"))).toBe(true);
  });

  test("accepts a canonical allowlist root and rejects a repository outside it", async () => {
    const parent = workRoot();
    const repo = join(parent, "allowed", "repo");
    mkdirSync(repo, { recursive: true });
    const initialized = repository();
    // Use a canonicalized symlink root without relying on the original fixture path.
    runGit(initialized, "clone", "--local", initialized, repo);
    const alias = join(parent, "allowed-alias");
    symlinkSync(join(parent, "allowed"), alias);
    const locator = { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" } as const;

    await syncWorkingTree(locator, "aliased", { allowedRoots: [alias] });
    await syncWorkingTree(locator, "filesystem-root", { allowedRoots: [sep] });
    await expectReason(
      () => syncWorkingTree(locator, "outside", { allowedRoots: [join(parent, "other")] }),
      "working_tree_not_allowed",
    );
    let thrown: unknown;
    try {
      await canonicalizeWorkingTreeLocator(
        { kind: "working-tree", repoRoot: join(repo, "nested"), subpath: "kit" },
        { allowedRoots: [repo] },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkingTreeAcquireError);
    expect((thrown as WorkingTreeAcquireError).code).toBe("working_tree_not_allowed");
  });

  test("rejects a Git top-level not owned by the Daemon uid", async () => {
    const process: GitProcess = {
      run: async (args) => {
        if (args.includes("--show-toplevel")) return gitResult("/tmp\n");
        throw new Error("unexpected Git command");
      },
    };
    await expectReason(
      () =>
        syncWorkingTree({ kind: "working-tree", repoRoot: "/tmp", subpath: "." }, "wt", {
          allowedRoots: ["/tmp"],
          process,
        }),
      "working_tree_not_allowed",
    );
  });

  test("rejects locator roots that are not the canonical Git top-level", async () => {
    const repo = repository();
    await expectReason(
      () =>
        syncWorkingTree(
          { kind: "working-tree", repoRoot: join(repo, "nested"), subpath: "kit" },
          "wt",
          { allowedRoots: [repo] },
        ),
      "working_tree_not_allowed",
    );
  });

  test("maps a non-directory Git top-level to the stable allowlist taxonomy", async () => {
    const work = workRoot();
    const topLevel = join(work, "not-a-directory");
    writeFileSync(topLevel, "plain file");
    const process: GitProcess = {
      run: async (args) =>
        args.includes("--show-toplevel") ? gitResult(`${topLevel}\n`) : gitResult(),
    };
    await expectReason(
      () =>
        syncWorkingTree({ kind: "working-tree", repoRoot: topLevel, subpath: "." }, "wt", {
          allowedRoots: [work],
          process,
        }),
      "working_tree_not_allowed",
    );
  });

  test("preserves file bytes and executable modes, dereferences file links, and moves the identity", async () => {
    const repo = repository();
    const skills = join(repo, "nested", "kit", "capabilities", "skills");
    symlinkSync("tracked/SKILL.md", join(skills, "skill-link"));
    const locator = { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" } as const;

    const first = await syncWorkingTree(locator, "wt", { allowedRoots: [repo] });
    const mirror = first.mirror;
    expect(readFileSync(join(mirror, "capabilities", "skills", "tracked", "bytes.bin"))).toEqual(
      Buffer.from([0, 255, 17, 128]),
    );
    expect(
      lstatSync(join(mirror, "capabilities", "skills", "tracked", "SKILL.md")).mode & 0o777,
    ).toBe(0o755);
    const link = join(mirror, "capabilities", "skills", "skill-link");
    expect(lstatSync(link).isFile()).toBe(true);
    expect(lstatSync(link).mode & 0o777).toBe(0o755);
    expect(readFileSync(link, "utf8")).toContain("name: tracked");

    writeFileSync(join(skills, "tracked", "bytes.bin"), Buffer.from([0, 255, 18, 128]));
    const second = await syncWorkingTree(locator, "wt", { allowedRoots: [repo] });
    expect(second.record?.contentDigest).not.toBe(first.record?.contentDigest);
  });

  test("rejects a selected root outside the tree and drops links that resolve outside it", async () => {
    const repo = repository();
    const outside = workRoot();
    const selected = join(repo, "nested", "kit");
    runGit(repo, "mv", "nested/kit", "nested/real-kit");
    symlinkSync(outside, selected);
    const locator = { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" } as const;
    await expectReason(
      () => syncWorkingTree(locator, "selected-root", { allowedRoots: [repo] }),
      "invalid_subpath",
    );

    // Restore a normal selected directory, then use an ignored intermediary so
    // the tracked link's immediate target looks internal while its real target is not.
    rmSync(selected, { force: true });
    runGit(repo, "mv", "nested/real-kit", "nested/kit");
    const skills = join(repo, "nested", "kit", "capabilities", "skills");
    writeFileSync(
      join(repo, ".git", "info", "exclude"),
      "nested/kit/capabilities/skills/ignored-bridge\n",
    );
    symlinkSync("/etc/passwd", join(skills, "ignored-bridge"));
    symlinkSync("ignored-bridge", join(skills, "indirect-escape"));
    runGit(repo, "add", "nested/kit/capabilities/skills/indirect-escape");
    const { mirror } = await syncWorkingTree(locator, "links", { allowedRoots: [repo] });
    expect(existsSync(join(mirror, "capabilities", "skills", "indirect-escape"))).toBe(false);
    expect(existsSync(join(mirror, "capabilities", "skills", "ignored-bridge"))).toBe(false);
    expect(existsSync(join(mirror, "capabilities", "skills", "tracked", "SKILL.md"))).toBe(true);
  });

  test("enforces shared file, byte, and capture-time budgets", async () => {
    const repo = repository();
    const locator = { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" } as const;
    await expectReason(
      () => captureWithLimits(locator, [repo], { ...DEFAULT_TREE_LIMITS, maxFiles: 1 }),
      "budget_exceeded",
    );
    await expectReason(
      () => captureWithLimits(locator, [repo], { ...DEFAULT_TREE_LIMITS, maxBytes: 1 }),
      "budget_exceeded",
    );
    await expectReason(
      () =>
        captureWithLimits(
          locator,
          [repo],
          { ...DEFAULT_TREE_LIMITS, timeoutMs: 1 },
          localGitProcess(async () => {
            await Bun.sleep(10);
          }),
        ),
      "timeout",
    );
  });

  test("retries when an existing untracked or already-dirty tracked file changes during capture", async () => {
    const fixtures: Array<{ path: [string, string]; before?: string }> = [
      { path: ["untracked", "SKILL.md"], before: undefined },
      { path: ["tracked", "SKILL.md"], before: "dirty before capture\n" },
    ];
    for (const fixture of fixtures) {
      const repo = repository();
      const skills = join(repo, "nested", "kit", "capabilities", "skills");
      const source = join(skills, ...fixture.path);
      if (fixture.before) writeFileSync(source, fixture.before);
      let statusCalls = 0;
      const process = localGitProcess((args) => {
        if (!args.includes("status")) return;
        statusCalls++;
        if (statusCalls === 2) writeFileSync(source, "changed during capture\n");
      });

      const { mirror } = await syncWorkingTree(
        { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
        fixture.path[0],
        { allowedRoots: [repo], process },
      );

      expect(readFileSync(join(mirror, "capabilities", "skills", ...fixture.path), "utf8")).toBe(
        "changed during capture\n",
      );
      expect(statusCalls).toBe(4);
    }
  });

  test("retries once when the source changes, then fails if it changes again", async () => {
    const repo = repository();
    let statusCalls = 0;
    let mutations = 0;
    const mutateAfterListing = (repeat: boolean) =>
      localGitProcess((args) => {
        if (!args.includes("status")) return;
        statusCalls++;
        if (statusCalls % 2 !== 0 || (!repeat && mutations > 0)) return;
        mutations++;
        const path = `nested/kit/capabilities/mutation-${mutations}.txt`;
        writeFileSync(join(repo, path), `mutation ${mutations}\n`);
        runGit(repo, "add", path);
        runGit(repo, "commit", "-m", `mutation ${mutations}`);
      });
    const locator = { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" } as const;

    const retried = await syncWorkingTree(locator, "retried", {
      allowedRoots: [repo],
      process: mutateAfterListing(false),
    });
    expect(retried.record?.origin).toMatchObject({ head: runGit(repo, "rev-parse", "HEAD") });

    statusCalls = 0;
    mutations = 100;
    await expectReason(
      () =>
        syncWorkingTree(locator, "changed", {
          allowedRoots: [repo],
          process: mutateAfterListing(true),
        }),
      "working_tree_changed",
    );
  });

  test("retries a file-to-symlink swap instead of reading through the replacement", async () => {
    const repo = repository();
    const source = join(repo, "nested", "kit", "capabilities", "skills", "tracked", "SKILL.md");
    const held = `${source}.held`;
    let statusCalls = 0;
    const process = localGitProcess((args) => {
      if (!args.includes("status")) return;
      statusCalls++;
      if (statusCalls === 2) {
        renameSync(source, held);
        symlinkSync("/etc/passwd", source);
      } else if (statusCalls === 3) {
        rmSync(source);
        renameSync(held, source);
      }
    });

    const { mirror } = await syncWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      "wt",
      { allowedRoots: [repo], process },
    );
    expect(
      readFileSync(join(mirror, "capabilities", "skills", "tracked", "SKILL.md"), "utf8"),
    ).toContain("name: tracked");
    expect(statusCalls).toBe(4);
  });

  test("retries a parent-directory swap instead of reopening outside the selected root", async () => {
    const repo = repository();
    const work = workRoot();
    const parent = join(repo, "nested", "kit", "capabilities", "skills", "tracked");
    const held = `${parent}.held`;
    const outside = join(work, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "outside bytes\n");
    writeFileSync(join(outside, "bytes.bin"), "outside bytes\n");
    let statusCalls = 0;
    const process = localGitProcess((args) => {
      if (!args.includes("status")) return;
      statusCalls++;
      if (statusCalls === 2) {
        renameSync(parent, held);
        symlinkSync(outside, parent);
      } else if (statusCalls === 3) {
        rmSync(parent);
        renameSync(held, parent);
      }
    });

    const { mirror } = await syncWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      "wt",
      { allowedRoots: [repo], process },
    );
    expect(
      readFileSync(join(mirror, "capabilities", "skills", "tracked", "SKILL.md"), "utf8"),
    ).toContain("name: tracked");
    expect(statusCalls).toBe(4);
  });

  test("re-captures from a fresh snapshot after a same-path parent directory replacement", async () => {
    const repo = repository();
    const work = workRoot();
    const parent = join(repo, "nested", "kit", "capabilities", "skills", "tracked");
    const held = join(work, "held");
    const replacement = join(work, "replacement");
    cpSync(parent, replacement, { recursive: true });
    writeFileSync(
      join(replacement, "SKILL.md"),
      "---\nname: tracked\ndescription: replaced\n---\n",
    );
    let statusCalls = 0;
    const process = localGitProcess((args) => {
      if (!args.includes("status")) return;
      statusCalls++;
      if (statusCalls === 2) {
        renameSync(parent, held);
        renameSync(replacement, parent);
      }
    });

    const { mirror } = await syncWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      "wt",
      { allowedRoots: [repo], process },
    );
    expect(
      readFileSync(join(mirror, "capabilities", "skills", "tracked", "SKILL.md"), "utf8"),
    ).toContain("description: replaced");
    expect(statusCalls).toBe(4);
  });
});
