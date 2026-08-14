import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { SyncError } from "../effect/errors.ts";
import { mirrorExists, readProvenance } from "../mirror.ts";
import { type HttpFetch, parseGithubOrigin, syncSource } from "../sync.ts";
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

// Sync one Source into mirrors/<id> using the shared tmp root.
function runOne(
  sourceId: string,
  origin: string,
  fetchImpl: HttpFetch,
): Effect.Effect<{ status: "synced" | "unchanged" }, SyncError> {
  const targets = failSafeDeployTargets();
  return syncSource(targets.mirrorRoot(sourceId), targets.kitTmpRoot(), origin, fetchImpl);
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

describe("syncSource", () => {
  test("(a) resolves main sha and downloads BY FULL SHA, writes mirror+provenance", async () => {
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

    expect(mirrorExists(mirror)).toBe(true);
    expect(readProvenance(mirror)?.sha).toBe(SHA_A);
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

  test("(parse error) a non-GitHub origin yields a typed parse SyncError (no throw)", async () => {
    const fetchImpl: HttpFetch = async () => {
      throw new Error("should not fetch");
    };
    const exit = await Effect.runPromiseExit(
      runOne("src-x", "https://gitlab.com/owner/repo", fetchImpl),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("parse");
    }
  });

  test("(b) unchanged short-circuits — no re-download at the same recorded sha", async () => {
    let downloads = 0;
    const fetchImpl: HttpFetch = async (url) => {
      if (url.includes("api.github.com")) return commitsResponse(SHA_A);
      downloads++;
      return tarballResponse(SHA_A);
    };

    const first = await Effect.runPromise(runOne("src-a", ORIGIN, fetchImpl));
    expect(first.status).toBe("synced");
    expect(downloads).toBe(1);

    const second = await Effect.runPromise(runOne("src-a", ORIGIN, fetchImpl));
    expect(second.status).toBe("unchanged");
    expect(downloads).toBe(1); // NOT re-downloaded
  });

  test("(c) offline — fetch throws -> SyncError.reason offline, prior mirror intact", async () => {
    const targets = failSafeDeployTargets();
    const mirror = targets.mirrorRoot("src-a");
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runOne("src-a", ORIGIN, seed));
    expect(mirrorExists(mirror)).toBe(true);

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
    expect(mirrorExists(mirror)).toBe(true);
    expect(readProvenance(mirror)?.sha).toBe(SHA_A);
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
    expect(readProvenance(mirrorA)?.sha).toBe(SHA_A);
    expect(readProvenance(mirrorB)?.sha).toBe(SHA_B);
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
    expect(mirrorExists(mirror)).toBe(true);
    expect(readProvenance(mirror)?.sha).toBe(SHA_A);
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
    expect(readProvenance(mirror)?.sha).toBe(SHA_A);
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
    expect(mirrorExists(mirror)).toBe(true);
    expect(existsSync(join(mirror, "capabilities", "skills", "foo", "SKILL.md"))).toBe(true);
  });
});
