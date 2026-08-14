import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitProcess, GitProcessFailure } from "../acquisition/git-process.ts";
import {
  acquireGitSource,
  GitAcquireError,
  repositoryLockCountForTest,
} from "../acquisition/git-source.ts";
import { extractBoundedTree, TreeGuardError } from "../acquisition/tree-guard.ts";
import { readProvenance } from "../mirror.ts";

const roots: string[] = [];
const TEST_COMMIT = "a".repeat(40);
const FIXTURE_REPOSITORY_URL = "https://fixture.invalid/acme/kits.git";

function gitResult(stdout = ""): { exitCode: number; stdout: Uint8Array; stderr: string } {
  return { exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: "" };
}

function localGitProcess(remote: string): GitProcess {
  return {
    async run(args, options) {
      const result = Bun.spawnSync(
        ["git", ...args.map((arg) => (arg === FIXTURE_REPOSITORY_URL ? remote : arg))],
        { cwd: options?.cwd, env: options?.env, stderr: "pipe", stdout: "pipe" },
      );
      const output = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr.toString(),
      };
      if (result.exitCode !== 0) throw new GitProcessFailure(args, output, false);
      return output;
    },
  };
}

function tarSpecialEntry(path: string): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(path), 0);
  header.set(encoder.encode("0000000\0"), 100);
  header.set(encoder.encode("00000000000\0"), 124);
  header[156] = "3".charCodeAt(0);
  return new Uint8Array([...header, ...new Uint8Array(1024)]);
}

function tarFileEntry(path: string, content = "x"): Uint8Array {
  const header = new Uint8Array(512);
  const data = new TextEncoder().encode(content);
  const encoder = new TextEncoder();
  header.set(encoder.encode(path), 0);
  header.set(encoder.encode("0000644\0"), 100);
  header.set(encoder.encode(`${data.byteLength.toString(8).padStart(11, "0")}\0`), 124);
  const padded = Math.ceil(data.byteLength / 512) * 512;
  const result = new Uint8Array(512 + padded + 1024);
  result.set(header, 0);
  result.set(data, 512);
  return result;
}

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function fixtureRepository(): { root: string; goodCommit: string } {
  const root = mkdtempSync(join(tmpdir(), "hive-git-source-"));
  roots.push(root);
  runGit(root, "init", "-b", "main");
  runGit(root, "config", "user.email", "hive@example.invalid");
  runGit(root, "config", "user.name", "Hive Test");
  const kit = join(root, "nested", "personal-kit");
  const skill = join(kit, "capabilities", "skills", "arca-smoke");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: arca-smoke\ndescription: smoke\n---\nbody\n");
  const executable = join(kit, "capabilities", "skills", "arca-smoke", "verify.sh");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  symlinkSync("arca-smoke", join(kit, "capabilities", "skills", "current"));
  mkdirSync(join(kit, "presets"), { recursive: true });
  writeFileSync(
    join(kit, "presets", "day-zero.yaml"),
    "name: day-zero\ndefault_agents: [claude]\ncapabilities:\n  skills: [arca-smoke]\n",
  );
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", "good kit");
  return { root, goodCommit: runGit(root, "rev-parse", "HEAD") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("git Source acquisition", () => {
  test("rejects a locator that is not credential-free HTTPS before running Git", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    let calls = 0;
    const git: GitProcess = {
      async run() {
        calls++;
        return gitResult();
      },
    };

    await expect(
      acquireGitSource(
        {
          kind: "git",
          repoUrl: "https://token@example.invalid/acme/kits.git",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
        join(work, "mirror"),
        { cacheRoot: join(work, "cache"), tmpRoot: join(work, "tmp"), process: git },
      ),
    ).rejects.toMatchObject({ code: "invalid_locator" });
    expect(calls).toBe(0);
  });

  test("maps Git failures to bounded acquisition errors", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const locator = {
      kind: "git" as const,
      repoUrl: "https://example.invalid/acme/kits.git",
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    };
    const failures = [
      {
        code: "auth_or_repository_unavailable",
        stderr: "fatal: repository not found",
        timedOut: false,
      },
      {
        code: "offline",
        stderr: "fatal: Could not resolve host: example.invalid",
        timedOut: false,
      },
      {
        code: "missing_ref",
        stderr: "fatal: couldn't find remote ref refs/heads/main",
        timedOut: false,
      },
      { code: "timeout", stderr: "", timedOut: true },
    ] as const;

    for (const failure of failures) {
      const git: GitProcess = {
        async run(args) {
          if (args.includes("fetch")) {
            throw new GitProcessFailure(
              args,
              { exitCode: 128, stdout: new Uint8Array(), stderr: failure.stderr },
              failure.timedOut,
            );
          }
          return gitResult();
        },
      };
      await expect(
        acquireGitSource(locator, join(work, failure.code), {
          cacheRoot: join(work, "cache", failure.code),
          tmpRoot: join(work, "tmp"),
          process: git,
        }),
      ).rejects.toMatchObject({ code: failure.code });
    }
  });

  test("rejects special archive entries before materialization", () => {
    const stage = mkdtempSync(join(tmpdir(), "hive-tree-guard-"));
    roots.push(stage);

    expect(() =>
      extractBoundedTree(tarSpecialEntry("device"), stage, {
        maxFiles: 20_000,
        maxBytes: 256 * 1024 * 1024,
      }),
    ).toThrow(TreeGuardError);
  });

  test("rejects backslash archive paths instead of normalizing them", () => {
    const stage = mkdtempSync(join(tmpdir(), "hive-tree-guard-"));
    roots.push(stage);

    expect(() =>
      extractBoundedTree(tarFileEntry("capabilities\\unsafe"), stage, {
        maxFiles: 20_000,
        maxBytes: 256 * 1024 * 1024,
      }),
    ).toThrow(TreeGuardError);
  });

  test("rejects traversal components even when they resolve within the staging root", () => {
    const stage = mkdtempSync(join(tmpdir(), "hive-tree-guard-"));
    roots.push(stage);

    expect(() =>
      extractBoundedTree(tarFileEntry("capabilities/../unsafe"), stage, {
        maxFiles: 20_000,
        maxBytes: 256 * 1024 * 1024,
      }),
    ).toThrow(TreeGuardError);
  });

  test("uses bounded partial fetch argv without changing the Daemon HOME", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const previousHome = process.env.HOME;
    process.env.HOME = join(work, "daemon-home");
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const git: GitProcess = {
      async run(args, options) {
        calls.push({ args, env: options?.env });
        if (args.includes("archive")) return gitResult("\0".repeat(1024));
        if (args.includes("rev-parse")) return gitResult(`${TEST_COMMIT}\n`);
        return gitResult();
      },
    };

    try {
      await acquireGitSource(
        {
          kind: "git",
          repoUrl: "https://example.invalid/acme/kits.git",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
        join(work, "mirror"),
        { cacheRoot: join(work, "cache"), tmpRoot: join(work, "tmp"), process: git },
      );
    } finally {
      process.env.HOME = previousHome;
    }

    expect(calls.some((call) => call.args.includes("clone"))).toBe(false);
    expect(
      calls.some(
        (call) => call.args.slice(-3).join("\0") === "config\0extensions.partialClone\0origin",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.args.slice(-6).join("\0") ===
          "fetch\0--filter=blob:none\0--no-tags\0--depth=1\0https://example.invalid/acme/kits.git\0refs/heads/main",
      ),
    ).toBe(true);
    expect(calls.every((call) => call.env?.HOME === join(work, "daemon-home"))).toBe(true);
  });

  test("releases a completed repository lock", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);

    await acquireGitSource(
      {
        kind: "git",
        repoUrl: FIXTURE_REPOSITORY_URL,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: "nested/personal-kit",
      },
      join(work, "mirror"),
      {
        cacheRoot: join(work, "cache"),
        tmpRoot: join(work, "tmp"),
        process: localGitProcess(repo.root),
      },
    );

    expect(repositoryLockCountForTest()).toBe(0);
  });

  test("materializes the selected subpath as the Mirror root with modes and safe links", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const destination = join(work, "mirror");

    const provenance = await acquireGitSource(
      {
        kind: "git",
        repoUrl: FIXTURE_REPOSITORY_URL,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: "nested/personal-kit",
      },
      destination,
      {
        cacheRoot: join(work, "cache"),
        tmpRoot: join(work, "tmp"),
        process: localGitProcess(repo.root),
      },
    );

    expect(
      readFileSync(join(destination, "capabilities", "skills", "arca-smoke", "SKILL.md"), "utf8"),
    ).toContain("name: arca-smoke");
    expect(existsSync(join(destination, "nested"))).toBe(false);
    expect(lstatSync(join(destination, "capabilities", "skills", "current")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      lstatSync(join(destination, "capabilities", "skills", "arca-smoke", "verify.sh")).mode &
        0o111,
    ).not.toBe(0);
    expect(provenance).toMatchObject({
      sha: repo.goodCommit,
      requestedRevision: { mode: "track", ref: "refs/heads/main" },
      resolvedCommit: repo.goodCommit,
      subpath: "nested/personal-kit",
    });
  });

  test("rejects an unavailable subpath and an over-budget selected tree", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const options = {
      cacheRoot: join(work, "cache"),
      tmpRoot: join(work, "tmp"),
      process: localGitProcess(repo.root),
    };
    const base = {
      kind: "git" as const,
      repoUrl: FIXTURE_REPOSITORY_URL,
      revision: { mode: "pin" as const, commit: repo.goodCommit },
    };

    await expect(
      acquireGitSource({ ...base, subpath: "missing" }, join(work, "missing"), options),
    ).rejects.toMatchObject({ code: "invalid_subpath" });
    await expect(
      acquireGitSource({ ...base, subpath: "nested/personal-kit" }, join(work, "limited"), {
        ...options,
        limits: { maxFiles: 20_000, maxBytes: 1, timeoutMs: 120_000 },
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  test("rejects an escaping link and retains the last-good Mirror", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const destination = join(work, "mirror");
    const options = {
      cacheRoot: join(work, "cache"),
      tmpRoot: join(work, "tmp"),
      process: localGitProcess(repo.root),
    };
    const pinned = {
      kind: "git" as const,
      repoUrl: FIXTURE_REPOSITORY_URL,
      revision: { mode: "pin" as const, commit: repo.goodCommit },
      subpath: "nested/personal-kit",
    };
    const pinnedProvenance = await acquireGitSource(pinned, destination, options);
    expect(pinnedProvenance.requestedRevision).toEqual({ mode: "pin", commit: repo.goodCommit });

    symlinkSync("../../../../outside", join(repo.root, "nested", "personal-kit", "escape"));
    runGit(repo.root, "add", ".");
    runGit(repo.root, "commit", "-m", "unsafe link");

    let thrown: unknown;
    try {
      await acquireGitSource(
        {
          ...pinned,
          revision: { mode: "track", ref: "refs/heads/main" },
        },
        destination,
        options,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GitAcquireError);
    expect((thrown as GitAcquireError).code).toBe("unsafe_tree");
    expect(readProvenance(destination)?.sha).toBe(repo.goodCommit);
    expect(existsSync(join(destination, "capabilities", "skills", "arca-smoke", "SKILL.md"))).toBe(
      true,
    );
  });
});
