/**
 * Deploy-isolation integration test (Plan B2 — the real safety boundary).
 *
 * A dev daemon (devMode, allowRealHomeDeploy:false — the fail-safe default)
 * performs a Deploy. It must:
 *   - populate the per-instance SANDBOX (<HIVE_RUNTIME_ROOT>/homes/.claude/…), and
 *   - leave the user's REAL ~/.claude / ~/.codex / ~/.agents deploy-target subpaths
 *     byte-identical (the tripwire is scoped to the EXACT subpaths a deploy would
 *     write — never a whole-home hash, per the known isolation gotcha).
 *
 * Critically this test sets HIVE_RUNTIME_ROOT only — NOT HIVE_*_HOME. So
 * `createServer` resolves homes through the config-driven ladder (devMode true in
 * the test process since HIVE_PACKAGED is unset, toggle off) → the sandbox. That
 * is the live dev path the plan fixes; a redirectHomeEnv()-based test would bypass
 * the very resolution under test.
 *
 * Only FILE-COPY capabilities (skills) are deployed — no installer subprocess
 * shells out against the real home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AddSourceResult } from "@hive/contract";
import { buildGzipTar, type TarFixtureEntry } from "../../kit/__tests__/helpers.ts";
import type { HttpFetch } from "../../kit/sync.ts";
import { createServer, type ServerHandles } from "../index.ts";
import { acceptDesiredSelection } from "./accepted-deploy-helpers.ts";

const TOKEN = "test-token";
const ORIGIN = "https://github.com/org/iso-source";
const SHA = "c".repeat(40);
// A deliberately unique capability name so its deploy-target subpath can never
// collide with a real file in the developer's home.
const ISO_SKILL_NAME = "hive-iso-tripwire-zzz";

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
      authorization: `Bearer ${TOKEN}`,
    },
  });
}

function tarTop(sha: string): string {
  return `repo-${sha.slice(0, 7)}`;
}

function isoSourceEntries(): TarFixtureEntry[] {
  const top = tarTop(SHA);
  return [
    { path: `${top}/` },
    {
      path: `${top}/capabilities/skills/${ISO_SKILL_NAME}/SKILL.md`,
      content: `---\nname: ${ISO_SKILL_NAME}\ndescription: isolation tripwire skill\n---\nbody\n`,
    },
  ];
}

function isoFetch(): HttpFetch {
  return async (url) => {
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
    }
    return new Response(buildGzipTar(isoSourceEntries()), { status: 200 });
  };
}

// The exact deploy-target subpaths the iso skill would write under each real home.
function realDeployTargetSubpaths(): string[] {
  const claude = join(homedir(), ".claude", "skills", ISO_SKILL_NAME);
  const codex = join(homedir(), ".codex", "skills", ISO_SKILL_NAME);
  const agents = join(homedir(), ".agents", "skills", ISO_SKILL_NAME);
  return [claude, codex, agents];
}

describe("deploy isolation — dev daemon (toggle off) never touches real homes", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-iso-"));
    // ONLY the runtime root — homes resolve through the config-driven ladder.
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
    // Ensure no HIVE_*_HOME / packaged marker leaks in from another test.
    delete process.env.HIVE_CLAUDE_HOME;
    delete process.env.HIVE_CODEX_HOME;
    delete process.env.HIVE_AGENTS_HOME;
    delete process.env.HIVE_LEDGER_PATH;
    delete process.env.HIVE_PACKAGED;
  });

  afterEach(() => {
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test("populates the sandbox; real ~/.claude/.codex/.agents subpaths byte-identical", async () => {
    // Tripwire: the unique subpaths must not exist before (they never should), and
    // must be unchanged after. We snapshot existence; the name is unique enough
    // that pre-existence would itself be a bug, but we assert the delta regardless.
    const realSubpaths = realDeployTargetSubpaths();
    const before = realSubpaths.map((p) => (existsSync(p) ? readFileSync(p, "utf8") : null));

    const server: ServerHandles = await createServer({
      mode: "memory",
      token: TOKEN,
      fetch: isoFetch(),
    });
    try {
      const add = await server.app.fetch(
        authed("/api/sources", {
          method: "POST",
          body: JSON.stringify({
            label: ORIGIN,
            locator: {
              kind: "git",
              repoUrl: ORIGIN,
              revision: { mode: "track", ref: "refs/heads/main" },
              subpath: ".",
            },
          }),
        }),
      );
      expect(add.status).toBe(201);
      AddSourceResult.parse(await add.json());

      const deploy = await acceptDesiredSelection(server, TOKEN, [
        {
          key: { kind: "skill", name: ISO_SKILL_NAME },
          targets: ["claude", "codex"],
        },
      ]);
      expect(deploy.lastOperation?.state).toBe("completed");

      // The SANDBOX is populated — claude (skills) + agents (codex skills land in
      // the agents home per the deploy contract).
      const sandbox = join(runtimeRoot, "homes");
      const sandboxClaudeSkill = join(sandbox, ".claude", "skills", ISO_SKILL_NAME, "SKILL.md");
      const sandboxAgentsSkill = join(sandbox, ".agents", "skills", ISO_SKILL_NAME, "SKILL.md");
      expect(existsSync(sandboxClaudeSkill)).toBe(true);
      expect(existsSync(sandboxAgentsSkill)).toBe(true);

      // The REAL homes' deploy-target subpaths are byte-identical (still absent).
      const after = realSubpaths.map((p) => (existsSync(p) ? readFileSync(p, "utf8") : null));
      expect(after).toEqual(before);
      for (const p of realSubpaths) {
        // None of the unique deploy-target subpaths were created in the real home.
        expect(existsSync(p)).toBe(false);
      }
    } finally {
      await server.dispose();
    }
  });
});
