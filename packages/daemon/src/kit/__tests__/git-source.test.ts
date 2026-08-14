import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import {
  type GitProcess,
  GitProcessFailure,
  productionGitProcess,
} from "../acquisition/git-process.ts";
import {
  acquireGitSource,
  GitAcquireError,
  repositoryLockCountForTest,
} from "../acquisition/git-source.ts";
import { extractBoundedTree, TreeGuardError } from "../acquisition/tree-guard.ts";
import { readProvenance } from "../mirror.ts";
import { buildTar } from "./helpers.ts";

const roots: string[] = [];
const TEST_COMMIT = "a".repeat(40);
const FIXTURE_REPOSITORY_URL = "https://fixture.invalid/acme/kits.git";

function gitResult(stdout = ""): { exitCode: number; stdout: Uint8Array; stderr: string } {
  return { exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: "" };
}

function emptyTreeResult(args: readonly string[]) {
  if (args.includes("--is-bare-repository")) return gitResult("true\n");
  if (args.includes("cat-file") && args.includes("-t")) return gitResult("tree\n");
  if (args.includes("ls-tree")) return gitResult();
  if (args.includes("rev-parse") && args.some((arg) => arg.includes("FETCH_HEAD"))) {
    return gitResult(`${TEST_COMMIT}\n`);
  }
  if (args.includes("rev-parse")) return gitResult(`${"b".repeat(40)}\n`);
  return gitResult();
}

function localGitProcess(remote: string): GitProcess {
  return testGitProcess(async (args, options) => {
    const localArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
      if (
        args[index] === "-c" &&
        (args[index + 1] === "protocol.allow=never" ||
          args[index + 1] === "protocol.https.allow=always")
      ) {
        index++;
        continue;
      }
      const arg = args[index];
      if (arg !== undefined) localArgs.push(arg === FIXTURE_REPOSITORY_URL ? remote : arg);
    }
    const env = { ...options?.env };
    delete env.GIT_ALLOW_PROTOCOL;
    const result = Bun.spawnSync(["git", ...localArgs], {
      cwd: options?.cwd,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const output = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
        .toString()
        .replace(/warning: filtering not recognized by server, ignoring\s*/gi, ""),
    };
    if (result.exitCode !== 0) throw new GitProcessFailure(args, output, false);
    return output;
  });
}

function testGitProcess(run: GitProcess["run"]): GitProcess {
  return { run, runArchive: (args, options) => run(args, options) };
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

function tarSymlinkEntry(path: string, target: string): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(path), 0);
  header.set(encoder.encode("0000777\0"), 100);
  header.set(encoder.encode("00000000000\0"), 124);
  header[156] = "2".charCodeAt(0);
  header.set(encoder.encode(target), 157);
  return new Uint8Array([...header, ...new Uint8Array(1024)]);
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
  test("materializes a root tree without adding a synthetic wrapper", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);

    await acquireGitSource(
      {
        kind: "git",
        repoUrl: FIXTURE_REPOSITORY_URL,
        revision: { mode: "pin", commit: repo.goodCommit },
        subpath: ".",
      },
      join(work, "mirror"),
      {
        cacheRoot: join(work, "cache"),
        tmpRoot: join(work, "tmp"),
        process: localGitProcess(repo.root),
      },
    );

    expect(existsSync(join(work, "mirror", "nested", "personal-kit", "capabilities"))).toBe(true);
  });

  test("preserves links that resolve exactly to the staged root", () => {
    const stage = mkdtempSync(join(tmpdir(), "hive-tree-guard-"));
    roots.push(stage);

    extractBoundedTree(tarSymlinkEntry("self", "."), stage, {
      maxFiles: 20_000,
      maxBytes: 256 * 1024 * 1024,
    });
    extractBoundedTree(tarSymlinkEntry("dir/up", ".."), stage, {
      maxFiles: 20_000,
      maxBytes: 256 * 1024 * 1024,
    });

    expect(readlinkSync(join(stage, "self"))).toBe(".");
    expect(readlinkSync(join(stage, "dir", "up"))).toBe("..");
  });

  test("exposes a bounded streaming archive runner", () => {
    expect((productionGitProcess() as { runArchive?: unknown }).runArchive).toBeTypeOf("function");
  });

  test("stops an archive stream at its byte budget and kills it at its deadline", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    writeFileSync(join(repo.root, "large"), "x".repeat(2 * 1024 * 1024));
    runGit(repo.root, "add", ".");
    runGit(repo.root, "commit", "-m", "large archive");
    const git = productionGitProcess();

    await expect(
      git.runArchive?.(["-C", repo.root, "archive", "--format=tar", "HEAD"], {
        maxBytes: 1,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ budgetExceeded: true, result: { stdout: expect.any(Uint8Array) } });

    const bin = join(work, "bin");
    const marker = join(work, "killed");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ntrap 'echo killed > "${marker}"; exit 0' TERM\nwhile :; do :; done\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    await expect(
      git.runArchive?.(["archive"], {
        env: { PATH: bin },
        maxBytes: 1,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ timedOut: true });
    expect(readFileSync(marker, "utf8").trim()).toBe("killed");
  });

  test("kills a TERM-resistant Git process group and its descendant after a bounded grace", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const bin = join(work, "bin");
    const leaderFile = join(work, "leader");
    const descendantFile = join(work, "descendant");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho $$ > "${leaderFile}"\ntrap '' TERM\n(sh -c 'trap "" TERM; while :; do sleep 1; done') &\necho $! > "${descendantFile}"\nwhile :; do sleep 1; done\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const running = productionGitProcess().run(["status"], {
      env: { PATH: bin },
      timeoutMs: 20,
    });

    try {
      await expect(
        Promise.race([
          running,
          Bun.sleep(1_000).then(() => {
            throw new Error("Git timeout did not settle");
          }),
        ]),
      ).rejects.toMatchObject({ timedOut: true });
      for (const pidFile of [leaderFile, descendantFile]) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      for (const pidFile of [leaderFile, descendantFile]) {
        if (!existsSync(pidFile)) continue;
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // The hardened runner already reaped it.
        }
      }
      await running.catch(() => undefined);
    }
  });

  test("caps retained Git diagnostics while draining the child stream", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      "#!/bin/sh\n/usr/bin/head -c 1048576 /dev/zero | /usr/bin/tr '\\0' x >&2\nexit 1\n",
    );
    chmodSync(join(bin, "git"), 0o755);

    let failure: unknown;
    try {
      await productionGitProcess().run(["status"], { env: { PATH: bin }, timeoutMs: 5_000 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitProcessFailure);
    expect((failure as GitProcessFailure).result.stderr.length).toBe(64 * 1024);
  });

  test("keeps the archive deadline after Git closes stdout", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const bin = join(work, "bin");
    const started = join(work, "started");
    const release = join(work, "release");
    const marker = join(work, "killed");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho started > "${started}"\nexec 1>&-\ntrap 'echo killed > "${marker}"; exit 0' TERM\nwhile [ ! -f "${release}" ]; do :; done\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const archive = productionGitProcess().runArchive(["archive"], {
      env: { PATH: bin },
      maxBytes: 1,
      timeoutMs: 20,
    });

    try {
      const outcome = await Promise.race([
        archive.then(
          () => "resolved",
          () => "rejected",
        ),
        Bun.sleep(100).then(() => "pending"),
      ]);
      expect(outcome).toBe("rejected");
      expect(readFileSync(marker, "utf8").trim()).toBe("killed");
    } finally {
      writeFileSync(release, "release");
      await archive.catch(() => undefined);
    }
  });

  test("maps cache and temporary-root filesystem failures to io", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const locator = {
      kind: "git" as const,
      repoUrl: "https://example.invalid/acme/kits.git",
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    };
    const git = testGitProcess(async (args) => {
      return emptyTreeResult(args);
    });
    const cacheFile = join(work, "cache-file");
    const tmpFile = join(work, "tmp-file");
    writeFileSync(cacheFile, "not a directory");
    writeFileSync(tmpFile, "not a directory");

    await expect(
      acquireGitSource(locator, join(work, "cache-failure"), {
        cacheRoot: cacheFile,
        tmpRoot: join(work, "tmp"),
        process: git,
      }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(
      acquireGitSource(locator, join(work, "tmp-failure"), {
        cacheRoot: join(work, "cache"),
        tmpRoot: tmpFile,
        process: git,
      }),
    ).rejects.toMatchObject({ code: "io" });
  });

  test("enforces one total acquisition deadline across Git and extraction", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const git = testGitProcess(async (args) => {
      await Bun.sleep(10);
      return emptyTreeResult(args);
    });

    await expect(
      acquireGitSource(
        {
          kind: "git",
          repoUrl: "https://example.invalid/acme/kits.git",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
        join(work, "mirror"),
        {
          cacheRoot: join(work, "cache"),
          tmpRoot: join(work, "tmp"),
          limits: { maxFiles: 20_000, maxBytes: 256 * 1024 * 1024, timeoutMs: 1 },
          process: git,
        },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  test("treats the Mirror rename as the success commit point", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const destination = join(work, "mirror");
    const realNow = Date.now;
    Date.now = () =>
      existsSync(join(destination, "capabilities", "skills", "arca-smoke", "SKILL.md")) ? 101 : 0;
    try {
      await expect(
        acquireGitSource(
          {
            kind: "git",
            repoUrl: FIXTURE_REPOSITORY_URL,
            revision: { mode: "pin", commit: repo.goodCommit },
            subpath: "nested/personal-kit",
          },
          destination,
          {
            cacheRoot: join(work, "cache"),
            tmpRoot: join(work, "tmp"),
            limits: { maxFiles: 20_000, maxBytes: 256 * 1024 * 1024, timeoutMs: 100 },
            process: localGitProcess(repo.root),
          },
        ),
      ).resolves.toMatchObject({ resolvedCommit: repo.goodCommit });
    } finally {
      Date.now = realNow;
    }
  });

  test("rejects a locator that is not credential-free HTTPS before running Git", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    let calls = 0;
    const git = testGitProcess(async () => {
      calls++;
      return gitResult();
    });

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

  test("rejects query and fragment credentials at the acquisition boundary", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    let calls = 0;
    const git = testGitProcess(async () => {
      calls++;
      return gitResult();
    });
    const base = {
      kind: "git" as const,
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    };
    for (const repoUrl of [
      "https://example.invalid/acme/kits?token=secret",
      "https://example.invalid/acme/kits#secret",
    ]) {
      await expect(
        acquireGitSource({ ...base, repoUrl }, join(work, crypto.randomUUID()), {
          cacheRoot: join(work, "cache"),
          tmpRoot: join(work, "tmp"),
          process: git,
        }),
      ).rejects.toMatchObject({ code: "invalid_locator" });
    }
    expect(calls).toBe(0);
  });

  test("rejects a server that ignores partial-fetch filtering and discards its cache", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const cacheRoot = join(work, "cache");
    const key = createHash("sha256").update("https://example.invalid/acme/kits").digest("hex");
    const cache = join(cacheRoot, key);
    mkdirSync(cache, { recursive: true });
    const git = testGitProcess(async (args) =>
      args.includes("fetch")
        ? { ...gitResult(), stderr: "warning: filtering not recognized by server, ignoring" }
        : args.includes("--is-bare-repository")
          ? gitResult("true\n")
          : gitResult(),
    );

    await expect(
      acquireGitSource(
        {
          kind: "git",
          repoUrl: "https://example.invalid/acme/kits.git",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
        join(work, "mirror"),
        { cacheRoot, tmpRoot: join(work, "tmp"), process: git },
      ),
    ).rejects.toMatchObject({ code: "auth_or_repository_unavailable" });
    expect(existsSync(cache)).toBe(false);
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
      const git = testGitProcess(async (args) => {
        if (args.includes("fetch")) {
          throw new GitProcessFailure(
            args,
            { exitCode: 128, stdout: new Uint8Array(), stderr: failure.stderr },
            failure.timedOut,
          );
        }
        return gitResult();
      });
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

  test("rejects unsupported entries from the raw Git tree", async () => {
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const git = testGitProcess(async (args) => {
      if (args.includes("ls-tree")) {
        return gitResult(`160000 commit ${"c".repeat(40)}\tsubmodule\0`);
      }
      return emptyTreeResult(args);
    });

    await expect(
      acquireGitSource(
        {
          kind: "git",
          repoUrl: "https://example.invalid/acme/kits.git",
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
        join(work, "mirror"),
        { cacheRoot: join(work, "cache"), tmpRoot: join(work, "tmp"), process: git },
      ),
    ).rejects.toMatchObject({ code: "unsafe_tree" });
    expect(existsSync(join(work, "mirror"))).toBe(false);
  });

  test("counts archive directories against the entry budget", () => {
    const stage = mkdtempSync(join(tmpdir(), "hive-tree-guard-"));
    roots.push(stage);
    expect(() =>
      extractBoundedTree(buildTar([{ path: "one/" }, { path: "two/" }]), stage, {
        maxFiles: 1,
        maxBytes: 1024,
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
    const blob = "c".repeat(40);
    const git = testGitProcess(async (args, options) => {
      calls.push({ args, env: options?.env });
      if (args.includes("ls-tree")) {
        return gitResult(`100644 blob ${blob}\tREADME.md\0`);
      }
      if (args.includes("cat-file") && args.includes("blob")) return gitResult("raw bytes\n");
      return emptyTreeResult(args);
    });

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
    const fetch = calls.find((call) => call.args.includes("fetch"));
    expect(fetch?.args).toContain("protocol.allow=never");
    expect(fetch?.args).toContain("protocol.https.allow=always");
    expect(fetch?.env?.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(
      calls.some(
        (call) =>
          call.args.includes("config") &&
          call.args.slice(-2).join("\0") ===
            "remote.origin.url\0https://example.invalid/acme/kits.git",
      ),
    ).toBe(true);
    const blobRead = calls.find(
      (call) => call.args.includes("cat-file") && call.args.includes("blob"),
    );
    expect(blobRead?.args).toContain("protocol.allow=never");
    expect(blobRead?.args).toContain("protocol.https.allow=always");
    expect(blobRead?.env?.GIT_ALLOW_PROTOCOL).toBe("https");
  });

  test("blocks ambient insteadOf rewrites from HTTPS to a local protocol", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const daemonHome = join(work, "daemon-home");
    mkdirSync(daemonHome);
    writeFileSync(
      join(daemonHome, ".gitconfig"),
      `[url "file://${repo.root}"]\n\tinsteadOf = https://rewrite.invalid/repo\n`,
    );
    const oldHome = process.env.HOME;
    process.env.HOME = daemonHome;
    try {
      await expect(
        acquireGitSource(
          {
            kind: "git",
            repoUrl: "https://rewrite.invalid/repo",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
          join(work, "mirror"),
          {
            cacheRoot: join(work, "cache"),
            tmpRoot: join(work, "tmp"),
            process: productionGitProcess(),
          },
        ),
      ).rejects.toMatchObject({ code: "auth_or_repository_unavailable" });
      expect(existsSync(join(work, "mirror"))).toBe(false);
    } finally {
      process.env.HOME = oldHome;
    }
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

  test("materializes committed bytes without export-ignore or export-subst transformations", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const kit = join(repo.root, "nested", "personal-kit");
    writeFileSync(join(kit, "hidden.txt"), "committed but export-ignored\n");
    writeFileSync(join(kit, "literal.txt"), "$Format:%H$\n");
    writeFileSync(
      join(kit, ".gitattributes"),
      "hidden.txt export-ignore\nliteral.txt export-subst\n",
    );
    runGit(repo.root, "add", ".");
    runGit(repo.root, "commit", "-m", "export attributes");
    const commit = runGit(repo.root, "rev-parse", "HEAD");

    await acquireGitSource(
      {
        kind: "git",
        repoUrl: FIXTURE_REPOSITORY_URL,
        revision: { mode: "pin", commit },
        subpath: "nested/personal-kit",
      },
      join(work, "mirror"),
      {
        cacheRoot: join(work, "cache"),
        tmpRoot: join(work, "tmp"),
        process: localGitProcess(repo.root),
      },
    );

    expect(readFileSync(join(work, "mirror", "hidden.txt"), "utf8")).toBe(
      "committed but export-ignored\n",
    );
    expect(readFileSync(join(work, "mirror", "literal.txt"), "utf8")).toBe("$Format:%H$\n");
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
    await expect(
      acquireGitSource({ ...base, subpath: ".gitignore" }, join(work, "file-subpath"), options),
    ).rejects.toMatchObject({ code: "invalid_subpath" });
  });

  test("atomically recreates an incomplete cache directory", async () => {
    const repo = fixtureRepository();
    const work = mkdtempSync(join(tmpdir(), "hive-git-work-"));
    roots.push(work);
    const normalized = "https://fixture.invalid/acme/kits";
    const cache = join(work, "cache", createHash("sha256").update(normalized).digest("hex"));
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "interrupted"), "not a bare repository");

    await acquireGitSource(
      {
        kind: "git",
        repoUrl: FIXTURE_REPOSITORY_URL,
        revision: { mode: "pin", commit: repo.goodCommit },
        subpath: "nested/personal-kit",
      },
      join(work, "mirror"),
      {
        cacheRoot: join(work, "cache"),
        tmpRoot: join(work, "tmp"),
        process: localGitProcess(repo.root),
      },
    );
    expect(runGit(cache, "rev-parse", "--is-bare-repository")).toBe("true");
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
