/**
 * #38 hermetic e2e — the durable regression guard for the multi-Source pivot.
 *
 * Drives the daemon at its HTTP I/O edge (plain-async, grandfathered suite) over
 * the FULL add → sync → catalog → diff → deploy → verify-bytes → idempotent →
 * merge → shadow → hide/remove → unresolved-include-hard-fail chain, against TWO
 * synthetic stub-fetched git Sources. No real network, no real ~/.claude.
 *
 * Hermetic, mirroring routes-sources.test.ts: mode:"memory" (never seeds the
 * Starter, builds no fs.watch — so the Linux-CI memory-mode watcher hang is not
 * reintroduced) + FULL redirectHomeEnv() (every HIVE_* home under a temp tree —
 * a HIVE_RUNTIME_ROOT-only redirect would read the real ~/.claude and fail only
 * in the full suite) + an authed() Bearer helper + buildGzipTar fixtures.
 *
 * stubFetch here is a TWO-Source variant of the single-source private helper in
 * routes-sources.test.ts: it keys the served tarball + commit sha on the repo's
 * owner/repo path, because the merge/shadow pair needs two distinct Sources.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddSourceResult, type CapabilityEntry, type DiffEntry, type Ledger } from "@hive/contract";
import {
  buildGzipTar,
  clearHomeEnv,
  type RedirectedHome,
  redirectHomeEnv,
  type TarFixtureEntry,
} from "../../kit/__tests__/helpers.ts";
import type { HttpFetch } from "../../kit/sync.ts";
import { failSafeDeployTargets } from "../../kit/targets.ts";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";

// Two distinct Sources, keyed by owner/repo in the GitHub URLs the sync builds
// (api.github.com/repos/<owner>/<repo>/commits/main + codeload/<owner>/<repo>).
const ORIGIN_A = "https://github.com/org/source-a";
const ORIGIN_B = "https://github.com/org/source-b";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

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

// ---- fixtures: two synthetic Source tarballs ----

// A standalone snippet body used to prove include EXPANSION (no literal marker
// survives in the deployed SKILL.md).
const GREETING_BODY = "Hello from the resolved snippet.";
// The byte-identical capability A and B both provide → a Merge (one entry, ≥2
// sourceIds). Identical SKILL.md bytes under the same leaf name → same ContentSha.
const MERGED_SKILL = "---\nname: merged\ndescription: a merged skill\n---\nidentical body\n";
// The same-name/different-bytes capability → a Shadow. A added before B, so B
// (later insertion index) wins; A is shadowed.
const CONFLICT_FROM_A = "---\nname: conflict\ndescription: conflict A\n---\nbody from A\n";
const CONFLICT_FROM_B = "---\nname: conflict\ndescription: conflict B\n---\nbody from B\n";

function tarTop(sha: string): string {
  return `repo-${sha.slice(0, 7)}`;
}

// Source A: a skill with an include marker, the merge skill, the shadow skill,
// an agent, an instruction, and the snippet the include resolves to.
function sourceAEntries(): TarFixtureEntry[] {
  const top = tarTop(SHA_A);
  return [
    { path: `${top}/` },
    {
      path: `${top}/capabilities/skills/alpha/SKILL.md`,
      content: `---\nname: alpha\ndescription: alpha skill\n---\nintro\n<!-- include: greeting -->\noutro\n`,
    },
    { path: `${top}/capabilities/skills/merged/SKILL.md`, content: MERGED_SKILL },
    { path: `${top}/capabilities/skills/conflict/SKILL.md`, content: CONFLICT_FROM_A },
    {
      path: `${top}/capabilities/agents/helper/AGENT.md`,
      content: `---\nname: helper\ndescription: helper agent\n---\nhelper instructions\n`,
    },
    {
      path: `${top}/capabilities/instructions/house-rules.instructions.md`,
      content: `---\ndescription: house rules\n---\nbe terse and direct\n`,
    },
    {
      path: `${top}/capabilities/snippets/greeting.md`,
      content: GREETING_BODY,
    },
  ];
}

// Source B: the merge twin (byte-identical to A's `merged`) and the shadow twin
// (same name `conflict`, different bytes).
function sourceBEntries(): TarFixtureEntry[] {
  const top = tarTop(SHA_B);
  return [
    { path: `${top}/` },
    { path: `${top}/capabilities/skills/merged/SKILL.md`, content: MERGED_SKILL },
    { path: `${top}/capabilities/skills/conflict/SKILL.md`, content: CONFLICT_FROM_B },
  ];
}

// A single-Source fixture whose only skill carries an UNRESOLVED include marker —
// drives the strict-include hard-fail (deploy errors, no bytes land).
const ORIGIN_BAD = "https://github.com/org/source-bad";
const SHA_BAD = "c".repeat(40);
function sourceBadEntries(): TarFixtureEntry[] {
  const top = tarTop(SHA_BAD);
  return [
    { path: `${top}/` },
    {
      path: `${top}/capabilities/skills/wrecked/SKILL.md`,
      content: `---\nname: wrecked\ndescription: has a bad include\n---\nbefore\n<!-- include: NOPE -->\nafter\n`,
    },
  ];
}

// A stub fetch serving the synthetic tarballs, keyed by the EXACT `<owner>/<repo>`
// in the URL — the commits API returns that repo's sha; codeload returns its tar.
// The repo is extracted by an exact path-segment parse, never a loose substring
// (`.includes("org/source-b")` would falsely match `org/source-bad`).
function twoSourceFetch(): HttpFetch {
  const byRepo: Record<string, { sha: string; entries: TarFixtureEntry[] }> = {
    "org/source-a": { sha: SHA_A, entries: sourceAEntries() },
    "org/source-b": { sha: SHA_B, entries: sourceBEntries() },
    "org/source-bad": { sha: SHA_BAD, entries: sourceBadEntries() },
  };
  // api.github.com/repos/<owner>/<repo>/commits/main  OR
  // codeload.github.com/<owner>/<repo>/tar.gz/<sha>
  const repoFromUrl = (url: string): string => {
    const commits = /\/repos\/([^/]+\/[^/]+)\/commits\//.exec(url);
    if (commits?.[1]) return commits[1];
    const codeload = /codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//.exec(url);
    if (codeload?.[1]) return codeload[1];
    throw new Error(`stub fetch: cannot parse repo from URL ${url}`);
  };
  return async (url) => {
    const repo = repoFromUrl(url);
    const served = byRepo[repo];
    if (!served) throw new Error(`stub fetch: unexpected repo ${repo} (${url})`);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ sha: served.sha }), { status: 200 });
    }
    return new Response(buildGzipTar(served.entries), { status: 200 });
  };
}

// ---- helpers over the running server ----

async function postOrigin(server: ServerHandles, origin: string): Promise<Response> {
  return server.app.fetch(
    authed("/api/sources", {
      method: "POST",
      body: JSON.stringify({
        label: origin,
        locator: {
          kind: "git",
          repoUrl: origin,
          revision: { mode: "track", ref: "refs/heads/main" },
          subpath: ".",
        },
      }),
    }),
  );
}

async function getCatalog(server: ServerHandles): Promise<{ entries: CapabilityEntry[] }> {
  const res = await server.app.fetch(authed("/api/kit/catalog"));
  expect(res.status).toBe(200);
  return (await res.json()) as { entries: CapabilityEntry[] };
}

type SelectionInput = {
  skills?: string[];
  agents?: string[];
  instructions?: string[];
  targets?: ("claude" | "codex")[];
};
function selectionBody(sel: SelectionInput): string {
  return JSON.stringify({
    presets: [],
    add: {
      skills: sel.skills ?? [],
      agents: sel.agents ?? [],
      instructions: sel.instructions ?? [],
    },
    remove: {},
    targets: sel.targets ?? ["claude", "codex"],
  });
}

async function postDiff(
  server: ServerHandles,
  sel: SelectionInput,
): Promise<{ entries: DiffEntry[] }> {
  const res = await server.app.fetch(
    authed("/api/kit/diff", { method: "POST", body: selectionBody(sel) }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { entries: DiffEntry[] };
}

function entriesNamed(entries: CapabilityEntry[], kind: string, name: string): CapabilityEntry[] {
  return entries.filter((e) => e.kind === kind && e.name === name);
}

describe("server routes — #38 multi-Source e2e (add → deploy → merge/shadow → hide)", () => {
  let tmpRoot: string;
  let homes: RedirectedHome;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hive-e2e-"));
    // FULL redirect: every HIVE_* home under the temp tree — never the real ~/.claude.
    homes = redirectHomeEnv(tmpRoot);
  });

  afterEach(() => {
    clearHomeEnv();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function serverWith(fetch: HttpFetch): Promise<ServerHandles> {
    return createServer({ mode: "memory", token: TOKEN, fetch });
  }

  test("durable selection GET/PATCH revision contract and one refs-only audit event", async () => {
    const server = await serverWith(twoSourceFetch());
    try {
      const initial = await server.app.fetch(authed("/api/kit/selection"));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ revision: 1, enabled: [], removalIntents: [] });

      const mutation = {
        expectedRevision: 1,
        changes: [{ key: { kind: "skill", name: "alpha" }, enabled: true, targets: ["codex"] }],
      };
      const changed = await server.app.fetch(
        authed("/api/kit/selection", { method: "PATCH", body: JSON.stringify(mutation) }),
      );
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({
        revision: 2,
        enabled: [{ key: { kind: "skill", name: "alpha" }, targets: ["codex"] }],
        removalIntents: [],
      });

      const conflict = await server.app.fetch(
        authed("/api/kit/selection", { method: "PATCH", body: JSON.stringify(mutation) }),
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "selection_conflict", currentRevision: 2 });

      const audit = await server.app.fetch(authed("/api/audit?source=deploy"));
      const rows = (await audit.json()) as {
        event_type: string;
        payload: Record<string, unknown>;
      }[];
      const changes = rows.filter((row) => row.event_type === "selection.changed");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        event_type: "selection.changed",
        payload: {
          revision: 2,
          addedPerKind: { skill: 1 },
          removedPerKind: {},
          targetClis: ["codex"],
        },
      });
    } finally {
      await server.dispose();
    }
  });

  test("(a–i) full add→deploy→merge→shadow→hide/remove chain over two Sources", async () => {
    const server = await serverWith(twoSourceFetch());
    try {
      // ---- (a) add Source A → 201 AddSourceResult, Mirror built, conformant ----
      const addA = await postOrigin(server, ORIGIN_A);
      expect(addA.status).toBe(201);
      const bodyA = AddSourceResult.parse(await addA.json());
      const idA = bodyA.source.id;
      expect(bodyA.source.kind).toBe("git");
      expect(bodyA.validation.conformant).toBe(true);
      expect(bodyA.validation.errors).toEqual([]);
      expect(bodyA.validation.capabilityCount).toBeGreaterThan(0);
      const mirrorA = failSafeDeployTargets().mirrorRoot(idA);
      expect(existsSync(mirrorA)).toBe(true);

      // ---- (b) catalog lists A's caps with A's sourceId ----
      let cat = await getCatalog(server);
      const alpha = entriesNamed(cat.entries, "skill", "alpha")[0];
      expect(alpha).toBeDefined();
      expect(alpha?.deployable).toBe(true);
      expect(alpha?.sourceIds).toContain(idA);
      expect(entriesNamed(cat.entries, "agent", "helper")[0]?.sourceIds).toContain(idA);
      expect(entriesNamed(cat.entries, "instruction", "house-rules")[0]?.sourceIds).toContain(idA);

      // ---- (c) diff reports A's caps as "added" ----
      const sel: SelectionInput = {
        skills: ["alpha", "merged"],
        agents: ["helper"],
        instructions: ["house-rules"],
        targets: ["claude", "codex"],
      };
      const diff1 = await postDiff(server, sel);
      expect(diff1.entries.some((e) => e.name === "alpha" && e.change === "added")).toBe(true);
      expect(diff1.entries.some((e) => e.name === "helper" && e.change === "added")).toBe(true);
      expect(diff1.entries.some((e) => e.name === "house-rules" && e.change === "added")).toBe(
        true,
      );

      // ---- (d) deploy file-copy kinds → bytes land, include resolves, ledger names ----
      const dep1 = await server.app.fetch(
        authed("/api/kit/deploy", { method: "POST", body: selectionBody(sel) }),
      );
      expect(dep1.status).toBe(200);

      // Skills land under claude (HIVE_CLAUDE_HOME/skills) and codex (HIVE_AGENTS_HOME/skills).
      const alphaClaude = join(homes.claudeHome, "skills", "alpha", "SKILL.md");
      const alphaAgents = join(homes.agentsHome, "skills", "alpha", "SKILL.md");
      expect(existsSync(alphaClaude)).toBe(true);
      expect(existsSync(alphaAgents)).toBe(true);
      // The include marker is RESOLVED in the deployed SKILL.md — no literal marker.
      const deployedAlpha = readFileSync(alphaClaude, "utf8");
      expect(deployedAlpha).toContain(GREETING_BODY);
      expect(deployedAlpha).not.toContain("<!-- include:");
      // Agent (claude → agents/<name>.md) and instruction (claude → CLAUDE.md) land.
      expect(existsSync(join(homes.claudeHome, "agents", "helper.md"))).toBe(true);
      expect(existsSync(join(homes.claudeHome, "CLAUDE.md"))).toBe(true);

      // Ledger records each deployed NAME (no sourceId — agent-kit interop shape).
      const ledger1 = JSON.parse(readFileSync(homes.ledgerPath, "utf8")) as Ledger;
      expect(ledger1.skills.map((s) => s.name)).toEqual(
        expect.arrayContaining(["alpha", "merged"]),
      );
      expect(ledger1.agentDefs.map((a) => a.name)).toContain("helper");
      expect(ledger1.instructions.map((i) => i.name)).toContain("house-rules");
      // Provenance is on the CATALOG entry's sourceIds, never the ledger.
      for (const entry of ledger1.skills) {
        expect((entry as { sourceId?: unknown }).sourceId).toBeUndefined();
      }

      // ---- (e) re-deploy is idempotent: diff empty for those names, ledger unchanged ----
      const ledgerBytesBefore = readFileSync(homes.ledgerPath, "utf8");
      const diff2 = await postDiff(server, sel);
      for (const name of ["alpha", "merged", "helper", "house-rules"]) {
        expect(diff2.entries.some((e) => e.name === name)).toBe(false);
      }
      const dep2 = await server.app.fetch(
        authed("/api/kit/deploy", { method: "POST", body: selectionBody(sel) }),
      );
      expect(dep2.status).toBe(200);
      // The ledger is byte-identical (idempotent re-deploy writes the same set).
      expect(readFileSync(homes.ledgerPath, "utf8")).toBe(ledgerBytesBefore);

      // ---- (f) MERGE: add Source B (byte-identical `merged`) → one entry, ≥2 sourceIds ----
      const addB = await postOrigin(server, ORIGIN_B);
      expect(addB.status).toBe(201);
      const bodyB = AddSourceResult.parse(await addB.json());
      const idB = bodyB.source.id;

      cat = await getCatalog(server);
      const mergedEntries = entriesNamed(cat.entries, "skill", "merged");
      expect(mergedEntries.length).toBe(1);
      expect(mergedEntries[0]?.sourceIds.length).toBeGreaterThanOrEqual(2);
      expect(mergedEntries[0]?.sourceIds).toEqual(expect.arrayContaining([idA, idB]));
      expect(mergedEntries[0]?.deployable).toBe(true);
      expect(mergedEntries[0]?.shadowed).toBe(false);

      // ---- (g) SHADOW: `conflict` same name / different bytes — B (later) wins ----
      const conflictEntries = entriesNamed(cat.entries, "skill", "conflict");
      expect(conflictEntries.length).toBe(2);
      const conflictWinner = conflictEntries.find((e) => e.deployable);
      const conflictShadow = conflictEntries.find((e) => e.shadowed);
      expect(conflictWinner?.sourceIds[0]).toBe(idB);
      expect(conflictShadow?.sourceIds[0]).toBe(idA);
      expect(conflictShadow?.deployable).toBe(false);

      // Deploying `conflict` writes B's bytes (the winner), never A's shadowed bytes.
      const conflictSel: SelectionInput = { skills: ["conflict"], targets: ["claude"] };
      const depConflict = await server.app.fetch(
        authed("/api/kit/deploy", { method: "POST", body: selectionBody(conflictSel) }),
      );
      expect(depConflict.status).toBe(200);
      const deployedConflict = readFileSync(
        join(homes.claudeHome, "skills", "conflict", "SKILL.md"),
        "utf8",
      );
      expect(deployedConflict).toBe(CONFLICT_FROM_B);
      expect(deployedConflict).not.toBe(CONFLICT_FROM_A);

      // ---- (h) deactivate A hides A's caps; DELETE A → 204 + Mirror removed ----
      const off = await server.app.fetch(
        authed(`/api/sources/${idA}/deactivate`, { method: "POST" }),
      );
      expect(off.status).toBe(200);
      cat = await getCatalog(server);
      // `alpha`, `helper`, `house-rules` are A-only → gone from the catalog.
      expect(entriesNamed(cat.entries, "skill", "alpha").length).toBe(0);
      expect(entriesNamed(cat.entries, "agent", "helper").length).toBe(0);
      expect(entriesNamed(cat.entries, "instruction", "house-rules").length).toBe(0);
      // `merged` survives (B still provides it); `conflict` winner is still B.
      expect(entriesNamed(cat.entries, "skill", "merged").length).toBe(1);
      expect(entriesNamed(cat.entries, "skill", "conflict")[0]?.sourceIds[0]).toBe(idB);

      const del = await server.app.fetch(authed(`/api/sources/${idA}`, { method: "DELETE" }));
      expect(del.status).toBe(204);
      expect(existsSync(mirrorA)).toBe(false);
      const list = await server.app.fetch(authed("/api/sources"));
      const sources = (await list.json()) as { id: string }[];
      expect(sources.some((s) => s.id === idA)).toBe(false);
      expect(sources.some((s) => s.id === idB)).toBe(true);
    } finally {
      await server.dispose();
    }
  });

  test("(i) unresolved-include strict guard: the skill FAILS and lands no bytes", async () => {
    // The strict-include guard (transforms.ts:21) throws on an unknown `<!-- include:
    // NOPE -->` in a SKILL.md. The deploy engine is ordered best-effort, so that
    // throw is caught PER-SKILL as a `failed` entry inside a 200 response (not a
    // whole-HTTP-500) — but, decisively, the throw happens in transformSkill BEFORE
    // any writeSkillFolder, so NO bytes land for that skill. That is the guard:
    // a strict marker is never silently left literal, and the skill never deploys.
    const server = await serverWith(twoSourceFetch());
    try {
      const add = await postOrigin(server, ORIGIN_BAD);
      expect(add.status).toBe(201);
      // The skill is well-formed by the lenient schema (the bad include is a DEPLOY
      // -time strict-render failure, not a conformance error), so the add is clean.
      const body = AddSourceResult.parse(await add.json());
      expect(body.validation.capabilityCount).toBeGreaterThan(0);

      const sel = selectionBody({ skills: ["wrecked"], targets: ["claude"] });
      const dep = await server.app.fetch(authed("/api/kit/deploy", { method: "POST", body: sel }));
      expect(dep.status).toBe(200);
      const result = (await dep.json()) as {
        perKind: { kind: string; applied: string[]; failed: { name: string; error: string }[] }[];
      };
      const skillKind = result.perKind.find((k) => k.kind === "skill");
      // The skill is NOT applied; it is reported failed naming the unresolved include.
      expect(skillKind?.applied).not.toContain("wrecked");
      const failure = skillKind?.failed.find((f) => f.name === "wrecked");
      expect(failure).toBeDefined();
      expect(failure?.error).toContain("include 'NOPE' not found");
      // No bytes landed for the skill under the redirected claude home.
      expect(existsSync(join(homes.claudeHome, "skills", "wrecked", "SKILL.md"))).toBe(false);
    } finally {
      await server.dispose();
    }
  });

  test("(optional) plugin/bundle installer path is reached under SKIP hatches, no real exec", async () => {
    // The skip-hatches let the deploy REACH the installer bookkeeping (record the
    // applied name / pin) without spawning a real claude/git/npx — proving the
    // installer-invocation path with zero real tool-state mutation. We assert via
    // the deploy result's perKind applied list, and that no real process is needed
    // (the exec adapter's not_redirected guard would fire on a real installer, but
    // the SKIP hatch short-circuits before exec).
    process.env.AGENT_KIT_SKIP_PLUGIN_INSTALL = "1";
    process.env.AGENT_KIT_SKIP_BUNDLE_INSTALL = "1";
    // Re-use a Source carrying a plugin + bundle capability.
    const PLUGIN_ORIGIN = "https://github.com/org/source-pb";
    const PLUGIN_SHA = "d".repeat(40);
    const top = tarTop(PLUGIN_SHA);
    const pbEntries: TarFixtureEntry[] = [
      { path: `${top}/` },
      {
        path: `${top}/capabilities/plugins/myplugin.plugin.md`,
        content:
          "---\ndescription: p\nmarketplace_source: owner/market\nmarketplace_name: market\nplugin_name: myplugin\n---\nplugin\n",
      },
      {
        path: `${top}/capabilities/bundles/mybundle.bundle.md`,
        content:
          "---\ndescription: b\nsource: https://example.com/x.git\npinned_commit: abc123\ninstaller:\n  command: ./setup\n  flags: []\n---\nbundle\n",
      },
    ];
    const pbFetch: HttpFetch = async (url) => {
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ sha: PLUGIN_SHA }), { status: 200 });
      }
      return new Response(buildGzipTar(pbEntries), { status: 200 });
    };
    const server = await serverWith(pbFetch);
    try {
      const add = await postOrigin(server, PLUGIN_ORIGIN);
      expect(add.status).toBe(201);
      // (#45) The well-formed plugin + bundle pass the now-stricter validate() gate
      // end-to-end — a conformance flip would otherwise slip through this e2e, which
      // previously checked only HTTP 201 + the `applied` lists.
      expect(AddSourceResult.parse(await add.json()).validation.conformant).toBe(true);
      const sel = JSON.stringify({
        presets: [],
        add: { plugins: ["myplugin"], bundles: ["mybundle"] },
        remove: {},
        targets: ["claude"],
      });
      const dep = await server.app.fetch(authed("/api/kit/deploy", { method: "POST", body: sel }));
      expect(dep.status).toBe(200);
      const result = (await dep.json()) as {
        perKind: { kind: string; applied: string[] }[];
      };
      const plugin = result.perKind.find((k) => k.kind === "plugin");
      const bundle = result.perKind.find((k) => k.kind === "bundle");
      // The skip-hatch marks the name applied without any real exec.
      expect(plugin?.applied).toContain("myplugin");
      expect(bundle?.applied).toContain("mybundle");
    } finally {
      await server.dispose();
      delete process.env.AGENT_KIT_SKIP_PLUGIN_INSTALL;
      delete process.env.AGENT_KIT_SKIP_BUNDLE_INSTALL;
    }
  });
});
