// #36 (Q8) — toggling off or deleting a Source does NOT undeploy already-deployed
// artifacts and triggers NO Deploy: it is not an audited Deploy. Asserted at the
// HTTP boundary, where the kit deploy emitter IS wired (createServer) — NOT in
// audit-emission.test.ts, which never wires that emitter (vacuous there).
//
// After a real deploy: deactivate / delete a Source emits no new `deploy.accepted`
// audit row and writes no new bytes under the CLI-home target paths. Hermetic:
// stub fetch builds the Mirror; redirected temp homes; mode:"memory".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddSourceResult } from "@hive/contract";
import { buildGzipTar, clearHomeEnv, redirectHomeEnv } from "../../kit/__tests__/helpers.ts";
import type { HttpFetch } from "../../kit/sync.ts";
import { failSafeDeployTargets } from "../../kit/targets.ts";
import { createServer, type ServerHandles } from "../index.ts";
import { acceptDesiredSelection } from "./accepted-deploy-helpers.ts";

const TOKEN = "test-token";
const SHA = "a".repeat(40);

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

// A stub fetch that serves a one-skill repo tarball from codeload.
function skillRepoFetch(name: string): HttpFetch {
  const top = `repo-${SHA.slice(0, 7)}`;
  const tar = buildGzipTar([
    { path: `${top}/` },
    {
      path: `${top}/capabilities/skills/${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: a ${name} skill\n---\nbody\n`,
    },
  ]);
  return async (url) =>
    url.includes("api.github.com")
      ? new Response(JSON.stringify({ sha: SHA }), { status: 200 })
      : new Response(tar, { status: 200 });
}

// Recursively snapshot the relative file paths + sizes under a dir (sorted).
function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else out.push(`${rel}:${statSync(full).size}`);
    }
  };
  walk(root, "");
  return out.sort();
}

describe("server — toggle/delete never undeploys (#36 Q8)", () => {
  let tmpRoot: string;
  let server: ServerHandles;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hive-undeploy-"));
    // Redirect ALL HIVE_* homes (mirrors, ledger, CLI homes) under the temp tree —
    // the deploy lands in a redirected ~/.claude, never the real one.
    redirectHomeEnv(tmpRoot);
    server = await createServer({ mode: "memory", token: TOKEN, fetch: skillRepoFetch("foo") });
  });

  afterEach(async () => {
    await server.dispose();
    clearHomeEnv();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Add a Source (builds its Mirror), then deploy its skill to claude.
  async function addAndDeploy(): Promise<string> {
    const add = await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({
          label: "https://github.com/a/b",
          locator: {
            kind: "git",
            repoUrl: "https://github.com/a/b",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
        }),
      }),
    );
    const { source } = AddSourceResult.parse(await add.json());
    const deploy = await acceptDesiredSelection(server, TOKEN, [
      { key: { kind: "skill", name: "foo" }, targets: ["claude"] },
    ]);
    expect(deploy.lastOperation?.state).toBe("completed");
    return source.id;
  }

  async function acceptedDeployRows(): Promise<number> {
    return (await server.audit.query({ source: "deploy" })).filter(
      (row) => row.event_type === "deploy.accepted",
    ).length;
  }

  test("deactivate after deploy: no new deploy.accepted row, no new CLI-home bytes", async () => {
    const id = await addAndDeploy();
    const claudeHome = failSafeDeployTargets().claudeHome();

    const deployRowsBefore = await acceptedDeployRows();
    expect(deployRowsBefore).toBe(1); // the one real deploy
    const treeBefore = snapshotTree(claudeHome);
    expect(treeBefore.some((p) => p.includes("foo"))).toBe(true);

    const off = await server.app.fetch(authed(`/api/sources/${id}/deactivate`, { method: "POST" }));
    expect(off.status).toBe(200);

    // No new Deploy: the deploy-source audit count is unchanged.
    expect(await acceptedDeployRows()).toBe(deployRowsBefore);
    // No undeploy: the already-landed bytes are untouched (byte-identical tree).
    expect(snapshotTree(claudeHome)).toEqual(treeBefore);
  });

  test("delete after deploy: no new deploy.accepted row, no new CLI-home bytes", async () => {
    const id = await addAndDeploy();
    const claudeHome = failSafeDeployTargets().claudeHome();

    const deployRowsBefore = await acceptedDeployRows();
    expect(deployRowsBefore).toBe(1);
    const treeBefore = snapshotTree(claudeHome);

    const del = await server.app.fetch(authed(`/api/sources/${id}`, { method: "DELETE" }));
    expect(del.status).toBe(204);

    expect(await acceptedDeployRows()).toBe(deployRowsBefore);
    // The deployed artifacts survive the Source's deletion (never auto-undeployed).
    expect(snapshotTree(claudeHome)).toEqual(treeBefore);
  });
});
