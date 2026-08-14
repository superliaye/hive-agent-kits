import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@hive/contract";
import { Cause, Effect, Exit } from "effect";
import { createServer } from "../../server/index.ts";
import { type GitProcess, GitProcessFailure } from "../acquisition/git-process.ts";
import { SyncError } from "../effect/errors.ts";
import { readProvenance } from "../mirror.ts";
import { syncLocatorSource } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { buildTar, clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SHA = "a".repeat(40);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-locator-sync-"));
  redirectHomeEnv(root);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(root, { recursive: true, force: true });
});

function source(id: string, locator: Source["locator"], overrides: Partial<Source> = {}): Source {
  return {
    id,
    label: id,
    locator,
    // Deliberately disagree with the locator: transport dispatch must never use
    // these compatibility display fields.
    origin: "local:display-only",
    kind: "local",
    active: true,
    createdAt: 0,
    rank: 0,
    ...overrides,
  };
}

function result(stdout = "") {
  return { exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: "" };
}

function gitFixture(shouldFail = false): GitProcess {
  return {
    async run(args) {
      if (shouldFail && args.includes("fetch")) {
        throw new GitProcessFailure(
          args,
          {
            exitCode: 128,
            stdout: new Uint8Array(),
            stderr:
              "fatal: unable to access https://user:secret@example.invalid/repo: Could not resolve host",
          },
          false,
        );
      }
      if (args.includes("rev-parse") && args.some((arg) => arg.includes("FETCH_HEAD"))) {
        return result(SHA);
      }
      if (args.includes("rev-parse")) return result("b".repeat(40));
      return result();
    },
    async runArchive() {
      return {
        exitCode: 0,
        stdout: buildTar([
          { path: "capabilities/" },
          { path: "capabilities/skills/" },
          { path: "capabilities/skills/fixture/" },
          {
            path: "capabilities/skills/fixture/SKILL.md",
            content: "---\nname: fixture\ndescription: fixture\n---\nbody\n",
          },
        ]),
        stderr: "",
      };
    },
  };
}

function runGit(cwd: string, ...args: string[]): void {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
}

function workingTree(): string {
  const repo = join(root, "working-tree");
  mkdirSync(repo, { recursive: true });
  runGit(repo, "init", "-b", "main");
  runGit(repo, "config", "user.email", "hive@example.invalid");
  runGit(repo, "config", "user.name", "Hive Test");
  mkdirSync(join(repo, "plain"), { recursive: true });
  writeFileSync(join(repo, "plain", "README.md"), "not a capability kit\n");
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "plain subtree");
  return repo;
}

describe("locator-native Source sync", () => {
  test("uses Source.locator for starter and git, isolating mirrors by Source id", async () => {
    const targets = failSafeDeployTargets();
    const starterRoot = join(root, "starter");
    mkdirSync(join(starterRoot, "capabilities", "skills", "starter"), { recursive: true });
    writeFileSync(
      join(starterRoot, "capabilities", "skills", "starter", "SKILL.md"),
      "---\nname: starter\ndescription: starter\n---\nbody\n",
    );
    process.env.HIVE_STARTER_ROOT = starterRoot;

    const starter = source(
      "starter",
      { kind: "starter" },
      { origin: "https://bad.invalid/starter", kind: "git" },
    );
    const gitLocator = {
      kind: "git",
      repoUrl: "https://example.invalid/acme/kit",
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    } as const;
    const gitA = source("git-a", gitLocator);
    const gitB = source("git-b", gitLocator);

    await Effect.runPromise(syncLocatorSource(starter, targets));
    await Effect.runPromise(syncLocatorSource(gitA, targets, { gitProcess: gitFixture() }));
    await Effect.runPromise(syncLocatorSource(gitB, targets, { gitProcess: gitFixture() }));

    expect(
      existsSync(
        join(targets.mirrorRoot("starter"), "capabilities", "skills", "starter", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(targets.mirrorRoot("git-a"), "capabilities", "skills", "fixture", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(targets.mirrorRoot("git-b"), "capabilities", "skills", "fixture", "SKILL.md"),
      ),
    ).toBe(true);
    expect(readProvenance(targets.mirrorRoot("git-a"))?.transport).toBe("git");
  });

  test("a failed Git locator sync retains that Source's exact last-good mirror and redacts credentials", async () => {
    const targets = failSafeDeployTargets();
    const git = source("git", {
      kind: "git",
      repoUrl: "https://example.invalid/acme/kit",
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    });
    await Effect.runPromise(syncLocatorSource(git, targets, { gitProcess: gitFixture() }));
    const good = readProvenance(targets.mirrorRoot(git.id));

    const exit = await Effect.runPromiseExit(
      syncLocatorSource(git, targets, { gitProcess: gitFixture(true) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as SyncError;
      expect(error.reason).toBe("offline");
      expect(error.detail).toBe("repository fetch failed");
      expect(error.detail).not.toContain("secret");
    }
    expect(readProvenance(targets.mirrorRoot(git.id))).toEqual(good);
    expect(
      readFileSync(
        join(targets.mirrorRoot(git.id), "capabilities", "skills", "fixture", "SKILL.md"),
        "utf8",
      ),
    ).toContain("fixture");
  });

  test("server config reaches working-tree onboarding and an existing non-kit subpath remains an explicit empty Source", async () => {
    const repo = workingTree();
    const server = await createServer({ mode: "memory", token: "locator-sync" });
    try {
      await server.config.set("sources", { workingTreeRoots: [repo] });
      const response = await server.app.fetch(
        new Request("http://localhost/api/sources", {
          method: "POST",
          headers: {
            authorization: "Bearer locator-sync",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "plain subtree",
            locator: { kind: "working-tree", repoRoot: repo, subpath: "plain" },
          }),
        }),
      );
      expect(response.status).toBe(201);
      const added = (await response.json()) as {
        source: Source;
        sync: { state: string };
        validation: { capabilityCount: number; conformant: boolean };
      };
      expect(added.sync.state).toBe("up_to_date");
      expect(added.validation.capabilityCount).toBe(0);
      expect(added.validation.conformant).toBe(true);
      expect(
        server.kit.catalog().entries.some((entry) => entry.sourceIds.includes(added.source.id)),
      ).toBe(false);

      const rerun = await Effect.runPromise(server.kit.sync());
      expect(rerun.sources).toEqual([
        { sourceId: added.source.id, origin: repo, status: "synced" },
      ]);
    } finally {
      await server.dispose();
    }
  });
});
