import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { type GitProcess, GitProcessFailure } from "../acquisition/git-process.ts";
import { acquireWorkingTree, WorkingTreeAcquireError } from "../acquisition/working-tree.ts";

const roots: string[] = [];

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
  return { run, runArchive: (args, options) => run(args, options) };
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

async function expectCode(work: () => Promise<unknown>, code: WorkingTreeAcquireError["code"]) {
  let thrown: unknown;
  try {
    await work();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkingTreeAcquireError);
  expect((thrown as WorkingTreeAcquireError).code).toBe(code);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("working-tree Source acquisition", () => {
  test("snapshots tracked and non-ignored untracked files below the selected subpath", async () => {
    const repo = repository();
    const work = workRoot();
    const destination = join(work, "mirror");

    const provenance = await acquireWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      destination,
      { allowedRoots: [repo], tmpRoot: join(work, "tmp") },
    );

    expect(
      readFileSync(join(destination, "capabilities", "skills", "tracked", "SKILL.md"), "utf8"),
    ).toContain("name: tracked");
    expect(
      readFileSync(join(destination, "capabilities", "skills", "untracked", "SKILL.md"), "utf8"),
    ).toContain("name: untracked");
    expect(existsSync(join(destination, "capabilities", "skills", "ignored"))).toBe(false);
    expect(existsSync(join(destination, "nested"))).toBe(false);
    expect(existsSync(join(destination, "ignored.txt"))).toBe(false);
    expect(provenance.transport).toBe("working-tree");
    expect(provenance.dirty).toBe(true);
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

    await acquireWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      join(parent, "mirror"),
      { allowedRoots: [alias], tmpRoot: join(parent, "tmp") },
    );
    await acquireWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      join(parent, "filesystem-root-mirror"),
      { allowedRoots: [sep], tmpRoot: join(parent, "tmp") },
    );
    await expectCode(
      () =>
        acquireWorkingTree(
          { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
          join(parent, "outside-mirror"),
          { allowedRoots: [join(parent, "other")], tmpRoot: join(parent, "tmp") },
        ),
      "working_tree_not_allowed",
    );
  });

  test("rejects a Git top-level not owned by the Daemon uid", async () => {
    const work = workRoot();
    const process: GitProcess = {
      run: async (args) => {
        if (args.includes("--show-toplevel")) return gitResult("/tmp\n");
        throw new Error("unexpected Git command");
      },
      runArchive: async () => gitResult(),
    };
    await expectCode(
      () =>
        acquireWorkingTree(
          { kind: "working-tree", repoRoot: "/tmp", subpath: "." },
          join(work, "mirror"),
          { allowedRoots: ["/tmp"], tmpRoot: join(work, "tmp"), process },
        ),
      "working_tree_not_allowed",
    );
  });

  test("rejects locator roots that are not the canonical Git top-level", async () => {
    const repo = repository();
    const work = workRoot();
    await expectCode(
      () =>
        acquireWorkingTree(
          { kind: "working-tree", repoRoot: join(repo, "nested"), subpath: "kit" },
          join(work, "mirror"),
          { allowedRoots: [repo], tmpRoot: join(work, "tmp") },
        ),
      "working_tree_not_allowed",
    );
  });

  test("preserves file bytes, executable modes, safe links, and byte identity", async () => {
    const repo = repository();
    const work = workRoot();
    const skills = join(repo, "nested", "kit", "capabilities", "skills");
    symlinkSync("tracked/SKILL.md", join(skills, "skill-link"));
    const destination = join(work, "mirror");

    const first = await acquireWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      destination,
      { allowedRoots: [repo], tmpRoot: join(work, "tmp") },
    );
    expect(
      readFileSync(join(destination, "capabilities", "skills", "tracked", "bytes.bin")),
    ).toEqual(Buffer.from([0, 255, 17, 128]));
    expect(
      lstatSync(join(destination, "capabilities", "skills", "tracked", "SKILL.md")).mode & 0o777,
    ).toBe(0o755);
    expect(readlinkSync(join(destination, "capabilities", "skills", "skill-link"))).toBe(
      "tracked/SKILL.md",
    );

    writeFileSync(join(skills, "tracked", "bytes.bin"), Buffer.from([0, 255, 18, 128]));
    const second = await acquireWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      destination,
      { allowedRoots: [repo], tmpRoot: join(work, "tmp") },
    );
    expect(second.treeIdentity).not.toBe(first.treeIdentity);
  });

  test("rejects selected roots and links that resolve outside the selected tree", async () => {
    const repo = repository();
    const work = workRoot();
    const outside = workRoot();
    const selected = join(repo, "nested", "kit");
    runGit(repo, "mv", "nested/kit", "nested/real-kit");
    symlinkSync(outside, selected);
    await expectCode(
      () =>
        acquireWorkingTree(
          { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
          join(work, "selected-root-mirror"),
          { allowedRoots: [repo], tmpRoot: join(work, "tmp") },
        ),
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
    await expectCode(
      () =>
        acquireWorkingTree(
          { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
          join(work, "link-mirror"),
          { allowedRoots: [repo], tmpRoot: join(work, "tmp") },
        ),
      "unsafe_tree",
    );
  });

  test("enforces shared file, byte, and capture-time budgets", async () => {
    const repo = repository();
    const work = workRoot();
    const request = (
      limits: { maxFiles: number; maxBytes: number; timeoutMs: number },
      process?: GitProcess,
    ) =>
      acquireWorkingTree(
        { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
        join(work, `mirror-${limits.maxFiles}-${limits.maxBytes}-${limits.timeoutMs}`),
        { allowedRoots: [repo], tmpRoot: join(work, "tmp"), limits, process },
      );
    await expectCode(
      () => request({ maxFiles: 1, maxBytes: 1024, timeoutMs: 10_000 }),
      "budget_exceeded",
    );
    await expectCode(
      () => request({ maxFiles: 100, maxBytes: 1, timeoutMs: 10_000 }),
      "budget_exceeded",
    );
    await expectCode(
      () =>
        request(
          { maxFiles: 100, maxBytes: 1024, timeoutMs: 1 },
          localGitProcess(async () => {
            await Bun.sleep(10);
          }),
        ),
      "timeout",
    );
  });

  test("retries once when the source changes, then fails if it changes again", async () => {
    const repo = repository();
    const work = workRoot();
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

    const retried = await acquireWorkingTree(
      { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
      join(work, "retried"),
      { allowedRoots: [repo], tmpRoot: join(work, "tmp"), process: mutateAfterListing(false) },
    );
    expect(retried.sha).toMatch(/^[0-9a-f]{40}$/);

    statusCalls = 0;
    mutations = 100;
    await expectCode(
      () =>
        acquireWorkingTree(
          { kind: "working-tree", repoRoot: repo, subpath: "nested/kit" },
          join(work, "changed"),
          { allowedRoots: [repo], tmpRoot: join(work, "tmp"), process: mutateAfterListing(true) },
        ),
      "working_tree_changed",
    );
  });
});
