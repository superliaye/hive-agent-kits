import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@hive/contract";
import { Cause, Effect, Exit } from "effect";
import { SyncError } from "../effect/errors.ts";
import { readMirrorIdentity, readMirrorRecord } from "../mirror.ts";
import { type HttpFetch, parseGithubOrigin, syncLocatorSource } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { buildGzipTar, clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ORIGIN = "https://github.com/superliaye/my-agent-kits";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-test-"));
  redirectHomeEnv(tmpRoot);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function commitsResponse(sha: string): Response {
  return new Response(JSON.stringify({ sha }), { status: 200 });
}

function tarballResponse(sha: string): Response {
  const gz = buildGzipTar([
    { path: `my-agent-kits-${sha.slice(0, 7)}/` },
    {
      path: `my-agent-kits-${sha.slice(0, 7)}/capabilities/skills/foo/SKILL.md`,
      content: "---\ndescription: foo\n---\nbody",
    },
    {
      path: `my-agent-kits-${sha.slice(0, 7)}/presets/p.yaml`,
      content:
        "name: p\ndescription: d\ndefault_agents: [claude]\ncapabilities:\n  skills: [foo]\n",
    },
  ]);
  return new Response(gz, { status: 200 });
}

// Sync one GitHub Source through the memory-mode HTTP fixture into mirrors/<id>.
function runOne(
  sourceId: string,
  origin: string,
  fetchImpl: HttpFetch,
): Effect.Effect<{ status: "synced" | "unchanged" }, SyncError> {
  const source: Source = {
    id: sourceId,
    label: sourceId,
    locator: {
      kind: "git",
      repoUrl: origin,
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    },
    origin,
    kind: "git",
    active: true,
    createdAt: 0,
    rank: 0,
  };
  return syncLocatorSource(source, failSafeDeployTargets(), {
    legacyGithubFixtureFetch: fetchImpl,
  });
}

function syncedCommit(mirror: string): string | null {
  const origin = readMirrorRecord(mirror)?.origin;
  return origin?.transport === "tarball" ? origin.resolvedCommit : null;
}

describe("parseGithubOrigin", () => {
  test("accepts a normalized https GitHub origin", () => {
    expect(parseGithubOrigin("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("rejects a non-GitHub https URL", () => {
    expect(parseGithubOrigin("https://gitlab.com/owner/repo")).toBeNull();
  });

  test("rejects a non-https / malformed origin", () => {
    expect(parseGithubOrigin("git@github.com:owner/repo.git")).toBeNull();
    expect(parseGithubOrigin("https://github.com/owner")).toBeNull();
    expect(parseGithubOrigin("not a url")).toBeNull();
  });
});

describe("GitHub tarball fixture sync", () => {
  test("(a) resolves main sha and downloads BY FULL SHA, writes the Mirror and its record", async () => {
    const urls: string[] = [];
    const fetchImpl: HttpFetch = async (url) => {
      urls.push(url);
      if (url.includes("api.github.com")) return commitsResponse(SHA_A);
      return tarballResponse(SHA_A);
    };

    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("src-a");
    const outcome = await Effect.runPromise(runOne("src-a", ORIGIN, fetchImpl));

    expect(outcome.status).toBe("synced");

    // The download URL carries the FULL 40-hex sha, never /main.
    const dl = urls.find((u) => u.includes("codeload"));
    expect(dl).toBeDefined();
    expect(dl).toContain(SHA_A);
    expect(dl).not.toContain("/main");

    expect(syncedCommit(mirror)).toBe(SHA_A);
    expect(readMirrorRecord(mirror)?.recipe.id).toBe("capability-kit");
    // Content landed under mirrors/<id>/capabilities/...
    expect(existsSync(join(mirror, "capabilities", "skills", "foo", "SKILL.md"))).toBe(true);
  });

  test("(orchestrator) two active Sources land in two distinct mirrors", async () => {
    const fetchImpl: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    const targets = failSafeDeployTargets();

    await Effect.runPromise(runOne("src-a", "https://github.com/owner/a", fetchImpl));
    await Effect.runPromise(runOne("src-b", "https://github.com/owner/b", fetchImpl));

    const mirrorA = targets.mirrorRoot("src-a");
    const mirrorB = targets.mirrorRoot("src-b");
    expect(mirrorA).not.toBe(mirrorB);
    expect(existsSync(join(mirrorA, "capabilities", "skills", "foo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(mirrorB, "capabilities", "skills", "foo", "SKILL.md"))).toBe(true);
  });

  test("(b) re-syncing the same commit reports unchanged and keeps the Mirror identity", async () => {
    const fetchImpl: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    const mirror = failSafeDeployTargets().mirrorRoot("src-a");

    const first = await Effect.runPromise(runOne("src-a", ORIGIN, fetchImpl));
    const identity = readMirrorIdentity(mirror);
    const second = await Effect.runPromise(runOne("src-a", ORIGIN, fetchImpl));

    expect(first.status).toBe("synced");
    expect(second.status).toBe("unchanged");
    expect(identity).not.toBeNull();
    expect(readMirrorIdentity(mirror)).toBe(identity);
  });

  test("(c) offline — fetch throws -> SyncError.reason offline, prior mirror intact", async () => {
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("src-a");
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runOne("src-a", ORIGIN, seed));
    expect(syncedCommit(mirror)).toBe(SHA_A);

    const offline: HttpFetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const exit = await Effect.runPromiseExit(runOne("src-a", ORIGIN, offline));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("offline");
    }
    expect(syncedCommit(mirror)).toBe(SHA_A);
  });

  test("(offline-isolation) one Source offline keeps the other's last-good + freshness", async () => {
    const targets = failSafeDeployTargets();
    const mirrorA = targets.mirrorRoot("src-a");
    const mirrorB = targets.mirrorRoot("src-b");

    // Seed A good.
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runOne("src-a", "https://github.com/owner/a", seed));

    // A offline now; B succeeds.
    const aOffline: HttpFetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const exitA = await Effect.runPromiseExit(
      runOne("src-a", "https://github.com/owner/a", aOffline),
    );
    expect(Exit.isFailure(exitA)).toBe(true);

    const bOk: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_B) : tarballResponse(SHA_B);
    const outcomeB = await Effect.runPromise(runOne("src-b", "https://github.com/owner/b", bOk));
    expect(outcomeB.status).toBe("synced");

    // A keeps last-good at SHA_A; B is at SHA_B — independent freshness.
    expect(syncedCommit(mirrorA)).toBe(SHA_A);
    expect(syncedCommit(mirrorB)).toBe(SHA_B);
  });

  test("(d) rate_limited — 403 + x-ratelimit-reset header", async () => {
    const reset = 1_700_000_000;
    const fetchImpl: HttpFetch = async () =>
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-reset": String(reset) },
      });

    const exit = await Effect.runPromiseExit(runOne("src-a", ORIGIN, fetchImpl));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("rate_limited");
      expect((err as SyncError).rateLimitReset).toBe(reset);
    }
  });

  test("(e) atomic/last-good — extract failure (download 500) keeps the prior mirror", async () => {
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("src-a");
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runOne("src-a", ORIGIN, seed));

    const failing: HttpFetch = async (url) =>
      url.includes("api.github.com")
        ? commitsResponse(SHA_B)
        : new Response("boom", { status: 500 });

    const exit = await Effect.runPromiseExit(runOne("src-a", ORIGIN, failing));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
    }
    expect(syncedCommit(mirror)).toBe(SHA_A);
  });

  test("(e2) corrupt tarball -> parse SyncError, prior mirror intact", async () => {
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("src-a");
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runOne("src-a", ORIGIN, seed));

    const corrupt: HttpFetch = async (url) =>
      url.includes("api.github.com")
        ? commitsResponse(SHA_B)
        : new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }); // not gzip

    const exit = await Effect.runPromiseExit(runOne("src-a", ORIGIN, corrupt));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("parse");
    }
    expect(syncedCommit(mirror)).toBe(SHA_A);
  });

  test("(f) a successful sync leaves another acquisition's temp dir untouched", async () => {
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("src-a");
    const stale = join(targets.kitTmpRoot(), "extract-stale");
    mkdirSync(stale, { recursive: true });
    expect(existsSync(stale)).toBe(true);

    const fetchImpl: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    const outcome = await Effect.runPromise(runOne("src-a", ORIGIN, fetchImpl));

    expect(outcome.status).toBe("synced");
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(mirror, "capabilities", "skills", "foo", "SKILL.md"))).toBe(true);
  });
});
