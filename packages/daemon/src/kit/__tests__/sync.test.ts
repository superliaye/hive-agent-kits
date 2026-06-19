import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { SyncError } from "../effect/errors.ts";
import { mirrorExists, readProvenance } from "../mirror.ts";
import { type HttpFetch, runSync } from "../sync.ts";
import { defaultDeployTargets } from "../targets.ts";
import { buildGzipTar, clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

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

describe("runSync", () => {
  test("(a) resolves main sha and downloads BY FULL SHA, writes mirror+provenance", async () => {
    const urls: string[] = [];
    const fetchImpl: HttpFetch = async (url) => {
      urls.push(url);
      if (url.includes("api.github.com")) return commitsResponse(SHA_A);
      return tarballResponse(SHA_A);
    };

    const targets = defaultDeployTargets();
    const outcome = await Effect.runPromise(runSync(targets, fetchImpl));

    expect(outcome.status).toBe("synced");
    expect(outcome.provenance.sha).toBe(SHA_A);

    // The download URL carries the FULL 40-hex sha, never /main.
    const dl = urls.find((u) => u.includes("codeload"));
    expect(dl).toBeDefined();
    expect(dl).toContain(SHA_A);
    expect(dl).not.toContain("/main");

    expect(mirrorExists(targets)).toBe(true);
    expect(readProvenance(targets)?.sha).toBe(SHA_A);
  });

  test("(b) unchanged short-circuits — no re-download at the same recorded sha", async () => {
    let downloads = 0;
    const fetchImpl: HttpFetch = async (url) => {
      if (url.includes("api.github.com")) return commitsResponse(SHA_A);
      downloads++;
      return tarballResponse(SHA_A);
    };
    const targets = defaultDeployTargets();

    const first = await Effect.runPromise(runSync(targets, fetchImpl));
    expect(first.status).toBe("synced");
    expect(downloads).toBe(1);

    const second = await Effect.runPromise(runSync(targets, fetchImpl));
    expect(second.status).toBe("unchanged");
    expect(downloads).toBe(1); // NOT re-downloaded
  });

  test("(c) offline — fetch throws -> SyncError.reason offline, prior mirror intact", async () => {
    const targets = defaultDeployTargets();
    // Seed a good mirror first.
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runSync(targets, seed));
    expect(mirrorExists(targets)).toBe(true);

    const offline: HttpFetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const exit = await Effect.runPromiseExit(runSync(targets, offline));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("offline");
    }
    // Prior mirror untouched.
    expect(mirrorExists(targets)).toBe(true);
    expect(readProvenance(targets)?.sha).toBe(SHA_A);
  });

  test("(d) rate_limited — 403 + x-ratelimit-reset header", async () => {
    const reset = 1_700_000_000;
    const fetchImpl: HttpFetch = async () =>
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-reset": String(reset) },
      });
    const targets = defaultDeployTargets();

    const exit = await Effect.runPromiseExit(runSync(targets, fetchImpl));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("rate_limited");
      expect((err as SyncError).rateLimitReset).toBe(reset);
    }
  });

  test("(e) atomic/last-good — extract failure (download 500) keeps the prior mirror", async () => {
    const targets = defaultDeployTargets();
    // Seed good mirror at SHA_A.
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runSync(targets, seed));

    // New sha resolves, but the tarball download 500s -> typed SyncError, mirror intact.
    const failing: HttpFetch = async (url) =>
      url.includes("api.github.com")
        ? commitsResponse(SHA_B)
        : new Response("boom", { status: 500 });

    const exit = await Effect.runPromiseExit(runSync(targets, failing));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
    }
    // Last-good retained at SHA_A (not SHA_B).
    expect(mirrorExists(targets)).toBe(true);
    expect(readProvenance(targets)?.sha).toBe(SHA_A);
  });

  test("(e2) corrupt tarball -> parse SyncError, prior mirror intact", async () => {
    const targets = defaultDeployTargets();
    const seed: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    await Effect.runPromise(runSync(targets, seed));

    const corrupt: HttpFetch = async (url) =>
      url.includes("api.github.com")
        ? commitsResponse(SHA_B)
        : new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }); // not gzip

    const exit = await Effect.runPromiseExit(runSync(targets, corrupt));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).reason).toBe("parse");
    }
    expect(readProvenance(targets)?.sha).toBe(SHA_A);
  });

  test("(f) stale temp dir is swept on a successful sync; mirror uncorrupted", async () => {
    const targets = defaultDeployTargets();
    // Pre-create a stale extract dir under the kit tmp root.
    const stale = join(targets.kitTmpRoot(), "extract-stale");
    mkdirSync(stale, { recursive: true });
    expect(existsSync(stale)).toBe(true);

    const fetchImpl: HttpFetch = async (url) =>
      url.includes("api.github.com") ? commitsResponse(SHA_A) : tarballResponse(SHA_A);
    const outcome = await Effect.runPromise(runSync(targets, fetchImpl));

    expect(outcome.status).toBe("synced");
    expect(existsSync(stale)).toBe(false); // swept
    expect(mirrorExists(targets)).toBe(true);
    expect(
      existsSync(join(targets.mirrorRoot(), "capabilities", "skills", "foo", "SKILL.md")),
    ).toBe(true);
  });
});
