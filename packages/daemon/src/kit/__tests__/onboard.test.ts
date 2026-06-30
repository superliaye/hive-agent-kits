// onboardSource (#33) — the stateless add → sync → validate helper. Unit-level:
// the timeout path (a never-resolving fetch must fold to a check_failed/timeout
// sync within the budget, never hang) plus the well-formed-report invariants.
// mode-pure: redirected temp homes, stubbed fetch, no fs.watch, no clone paths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddSourceResult, type Source } from "@hive/contract";
import { Effect } from "effect";
import { degradedOnboardResult, onboardSource } from "../onboard.ts";
import type { HttpFetch } from "../sync.ts";
import { failSafeDeployTargets } from "../targets.ts";
import { buildGzipTar, clearHomeEnv, redirectHomeEnv } from "./helpers.ts";

const SHA = "a".repeat(40);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kit-onboard-"));
  redirectHomeEnv(tmpRoot);
});

afterEach(() => {
  clearHomeEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function gitSource(id: string, origin = "https://github.com/owner/repo"): Source {
  return { id, origin, kind: "git", active: true, createdAt: 0, rank: 0 };
}

function conformingTar(name = "foo"): Uint8Array {
  const top = `repo-${SHA.slice(0, 7)}`;
  return buildGzipTar([
    { path: `${top}/` },
    {
      path: `${top}/capabilities/skills/${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: a ${name} skill\n---\nbody\n`,
    },
  ]);
}

describe("onboardSource", () => {
  test("(timeout) a never-resolving sync folds to check_failed + errorReason timeout", async () => {
    // The commits API never resolves → the bounded sync must time out and fold a
    // `timeout` SyncError into the report; the add can't hang. The promise simply
    // never settles; timeoutOrElse interrupts the fiber at the budget.
    const neverFetch: HttpFetch = () => new Promise<Response>(() => {});
    const src = gitSource("src-timeout");
    const result = await Effect.runPromise(
      onboardSource(failSafeDeployTargets(), neverFetch, src, 50),
    );
    expect(result.sync.state).toBe("check_failed");
    expect(result.sync.errorReason).toBe("timeout");
    // No Mirror was built → the report is still well-formed (empty, conformant).
    expect(result.validation.conformant).toBe(true);
    expect(result.validation.capabilityCount).toBe(0);
    expect(result.source.id).toBe("src-timeout");
  });

  test("(success) reachable + conforming → up_to_date, conformant, count>0, Mirror built", async () => {
    const fetchImpl: HttpFetch = async (url) =>
      url.includes("api.github.com")
        ? new Response(JSON.stringify({ sha: SHA }), { status: 200 })
        : new Response(conformingTar("foo"), { status: 200 });
    const src = gitSource("src-ok");
    const result = await Effect.runPromise(
      onboardSource(failSafeDeployTargets(), fetchImpl, src, 30_000),
    );
    expect(result.sync.state).toBe("up_to_date");
    expect(result.validation.conformant).toBe(true);
    expect(result.validation.capabilityCount).toBeGreaterThan(0);
    expect(result.validation.errors).toEqual([]);
  });

  test("(offline) a throwing fetch folds to check_failed without rejecting", async () => {
    const offline: HttpFetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const src = gitSource("src-offline");
    // onboard's error channel is `never` — runPromise resolves, never rejects.
    const result = await Effect.runPromise(
      onboardSource(failSafeDeployTargets(), offline, src, 30_000),
    );
    expect(result.sync.state).toBe("check_failed");
    expect(result.sync.errorReason).toBe("offline");
    expect(result.validation.capabilityCount).toBe(0);
  });

  test("(degraded) the defect fallback body is well-formed and defect-HONEST", () => {
    // The body the server adapter / route emit only on a squashed defect: parses
    // against the contract AND reports conformant:false (NOT a clean empty repo —
    // a defect means conformance is unknown, never proven-clean).
    const src = gitSource("src-defect");
    const body = AddSourceResult.parse(degradedOnboardResult(src));
    expect(body.source.id).toBe("src-defect");
    expect(body.sync.state).toBe("check_failed");
    expect(body.sync.errorReason).toBe("io");
    expect(body.validation.conformant).toBe(false);
    expect(body.validation.errors.length).toBeGreaterThan(0);
    expect(body.validation.capabilityCount).toBe(0);
  });
});
