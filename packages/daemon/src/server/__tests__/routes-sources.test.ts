/**
 * HTTP routes for the Sources registry (ADR-0023) + add → sync → validate (#33).
 * Covers the five verbs and their pinned statuses, plus the add-on-validate body:
 *   - GET    /api/sources                 list (200)
 *   - POST   /api/sources                 add (400 malformed, 201 valid, 409 dup)
 *                                         201 body = AddSourceResult {source,sync,validation}
 *   - POST   /api/sources/:id/activate    (200, 404 unknown)
 *   - POST   /api/sources/:id/deactivate  (200)
 *   - DELETE /api/sources/:id             (204, 404 unknown) + removes the Mirror
 *
 * Hermetic: EVERY POST reaches onboard → fetch, so every server here injects a stub
 * fetch (buildGzipTar fixtures). No real network. mode:"memory", no fs.watch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddSourceResult } from "@hive/contract";
import {
  buildGzipTar,
  clearHomeEnv,
  redirectHomeEnv,
  type TarFixtureEntry,
} from "../../kit/__tests__/helpers.ts";
import type { HttpFetch } from "../../kit/sync.ts";
import { defaultDeployTargets } from "../../kit/targets.ts";
import { createServer, type ServerHandles } from "../index.ts";

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

// A stub fetch that resolves the commits API to a fixed sha and serves the given
// tarball entries from codeload. A null `entries` makes the tarball fetch FAIL
// (offline-style throw) — for the unreachable case.
function stubFetch(entries: TarFixtureEntry[] | null): HttpFetch {
  return async (url) => {
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
    }
    if (entries === null) throw new Error("ENOTFOUND");
    return new Response(buildGzipTar(entries), { status: 200 });
  };
}

// A stub fetch that returns 403 (rate-limited) on the commits API.
function rateLimitedFetch(): HttpFetch {
  return async () =>
    new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-reset": "1700000000" },
    });
}

// A top-folder-prefixed entry list for a Source repo with the given skills. Each
// `skill` is a { dir, frontmatter, body } — a conforming skill has name===dir.
// The timeout path is exercised at the onboardSource unit level (onboard.test.ts);
// the HTTP path here uses bounded stubs that settle quickly.
type SkillSpec = { dir: string; frontmatter: string; body?: string };
function repoTar(skills: SkillSpec[]): TarFixtureEntry[] {
  const top = `repo-${SHA.slice(0, 7)}`;
  const entries: TarFixtureEntry[] = [{ path: `${top}/` }];
  for (const s of skills) {
    entries.push({
      path: `${top}/capabilities/skills/${s.dir}/SKILL.md`,
      content: `---\n${s.frontmatter}\n---\n${s.body ?? "body"}\n`,
    });
  }
  return entries;
}

function conformingSkill(name: string): SkillSpec {
  return { dir: name, frontmatter: `name: ${name}\ndescription: a ${name} skill` };
}

async function postOrigin(server: ServerHandles, origin: string): Promise<Response> {
  return server.app.fetch(
    authed("/api/sources", { method: "POST", body: JSON.stringify({ origin }) }),
  );
}

describe("server routes — sources", () => {
  let tmpRoot: string;
  let runtimeRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    // Redirect ALL HIVE_* homes under the temp tree so catalog/diff/deploy reads
    // (mirrors, ledger, CLI homes) are fully isolated — never the real ~/.claude
    // or ~/.agent-kit, and never bled between tests.
    runtimeRoot = redirectHomeEnv(tmpRoot).runtimeRoot;
  });

  afterEach(() => {
    clearHomeEnv();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Build a memory-mode server with an injected stub fetch; dispose after each test.
  async function serverWith(fetch: HttpFetch): Promise<ServerHandles> {
    return createServer({ mode: "memory", token: TOKEN, fetch });
  }

  test("GET /api/sources returns empty list initially", async () => {
    const server = await serverWith(stubFetch([]));
    try {
      const res = await server.app.fetch(authed("/api/sources"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await server.dispose();
    }
  });

  test("POST /api/sources with malformed body → 400 (short-circuits before onboard)", async () => {
    const server = await serverWith(stubFetch([]));
    try {
      const res = await postOrigin(server, "mailto:x@y");
      expect(res.status).toBe(400);
    } finally {
      await server.dispose();
    }
  });

  test("POST /api/sources with an ftp URL → 400 (short-circuits before onboard)", async () => {
    const server = await serverWith(stubFetch([]));
    try {
      const res = await postOrigin(server, "ftp://example.com/repo");
      expect(res.status).toBe(400);
    } finally {
      await server.dispose();
    }
  });

  test("(#33) reachable + conforming → 201 AddSourceResult, up_to_date, conformant, count>0", async () => {
    const server = await serverWith(stubFetch(repoTar([conformingSkill("foo")])));
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      expect(res.status).toBe(201);
      // Body parses against the AddSourceResult contract schema.
      const body = AddSourceResult.parse(await res.json());
      expect(body.source.active).toBe(true);
      expect(body.source.kind).toBe("git");
      expect(body.sync.state).toBe("up_to_date");
      expect(body.validation.conformant).toBe(true);
      expect(body.validation.errors).toEqual([]);
      expect(body.validation.capabilityCount).toBeGreaterThan(0);

      // The Mirror is built at add time → the catalog serves the capability now,
      // resolved to the just-added Source as the winner (sourceIds winner-first).
      const cat = await server.app.fetch(authed("/api/kit/catalog"));
      const catalog = (await cat.json()) as {
        entries: { name: string; deployable: boolean; sourceIds: string[] }[];
      };
      const foo = catalog.entries.find((e) => e.name === "foo");
      expect(foo).toBeDefined();
      expect(foo?.deployable).toBe(true);
      expect(foo?.sourceIds[0]).toBe(body.source.id);

      // An immediate diff resolves that just-synced Mirror's winner — `foo` only
      // appears as `added` if resolveSelection found a deployable winner for it.
      const diffRes = await server.app.fetch(
        authed("/api/kit/diff", {
          method: "POST",
          body: JSON.stringify({
            presets: [],
            add: { skills: ["foo"] },
            remove: {},
            targets: ["claude"],
          }),
        }),
      );
      expect(diffRes.status).toBe(200);
      const diff = (await diffRes.json()) as { entries: { name: string; change: string }[] };
      expect(diff.entries.some((e) => e.name === "foo" && e.change === "added")).toBe(true);
    } finally {
      await server.dispose();
    }
  });

  test("(#33) reachable + a malformed skill → 201, conformant:false, located error", async () => {
    // name mismatch (name !== dir) is a located conformance error, not a rejection.
    const malformed: SkillSpec = {
      dir: "bar",
      frontmatter: "name: notbar\ndescription: a bar skill",
    };
    const server = await serverWith(stubFetch(repoTar([malformed])));
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      expect(res.status).toBe(201);
      const body = AddSourceResult.parse(await res.json());
      expect(body.validation.conformant).toBe(false);
      expect(body.validation.errors.length).toBeGreaterThan(0);
      expect(body.validation.errors[0]?.name).toBeDefined();
    } finally {
      await server.dispose();
    }
  });

  test("(#33) unreachable repo → 201, source registered, sync.state check_failed + errorReason", async () => {
    const server = await serverWith(stubFetch(null));
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      expect(res.status).toBe(201);
      const body = AddSourceResult.parse(await res.json());
      expect(["check_failed", "rate_limited"]).toContain(body.sync.state);
      // Possibly-undefined read — presence check, no `!`/cast.
      const reason = body.sync.errorReason;
      expect(typeof reason === "string" && reason.length > 0).toBe(true);

      // The Source is still registered.
      const list = await server.app.fetch(authed("/api/sources"));
      const sources = (await list.json()) as { id: string }[];
      expect(sources.length).toBe(1);
    } finally {
      await server.dispose();
    }
  });

  test("(#33) rate-limited repo → 201, sync.state rate_limited", async () => {
    const server = await serverWith(rateLimitedFetch());
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      expect(res.status).toBe(201);
      const body = AddSourceResult.parse(await res.json());
      expect(body.sync.state).toBe("rate_limited");
    } finally {
      await server.dispose();
    }
  });

  test("(#33) reachable + zero capabilities → 201, capabilityCount === 0", async () => {
    // An empty tarball (top folder only — no capabilities/).
    const server = await serverWith(stubFetch([{ path: `repo-${SHA.slice(0, 7)}/` }]));
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      expect(res.status).toBe(201);
      const body = AddSourceResult.parse(await res.json());
      expect(body.validation.capabilityCount).toBe(0);
    } finally {
      await server.dispose();
    }
  });

  test("(#33) reachable + within-kind collision → 201, count>0 (not empty), conformant", async () => {
    // Two well-formed same-named skills under @-groups: each is conformant on its
    // own, but they collide on (skill, baz) → both non-resolvable. They still
    // ENUMERATE as leaves → capabilityCount>0, never mislabeled empty.
    const a: SkillSpec = { dir: "baz", frontmatter: "name: baz\ndescription: a baz" };
    const top = `repo-${SHA.slice(0, 7)}`;
    const entries: TarFixtureEntry[] = [
      { path: `${top}/` },
      {
        path: `${top}/capabilities/skills/@x/baz/SKILL.md`,
        content: `---\n${a.frontmatter}\n---\nbody A\n`,
      },
      {
        path: `${top}/capabilities/skills/@y/baz/SKILL.md`,
        content: `---\n${a.frontmatter}\n---\nbody B\n`,
      },
    ];
    const server = await serverWith(stubFetch(entries));
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      expect(res.status).toBe(201);
      const body = AddSourceResult.parse(await res.json());
      // Both skills are well-formed → strict validate finds no conformance error.
      expect(body.validation.conformant).toBe(true);
      // Crucially NOT mislabeled empty.
      expect(body.validation.capabilityCount).toBeGreaterThan(0);
    } finally {
      await server.dispose();
    }
  });

  test("(#33) GET /api/kit/state after a failed add reports errorReason no_mirror", async () => {
    const server = await serverWith(stubFetch(null));
    try {
      const res = await postOrigin(server, "https://github.com/a/b");
      const body = AddSourceResult.parse(await res.json());
      // The add-time response carries the specific cause (offline → check_failed).
      expect(body.sync.state).toBe("check_failed");
      expect(body.sync.errorReason).toBe("offline");

      // The disk-re-derived state reports `no_mirror` (no Mirror was built) — the
      // intentional, pinned divergence from the add-time cause.
      const stateRes = await server.app.fetch(authed("/api/kit/state"));
      const state = (await stateRes.json()) as {
        sync: { sourceId: string; errorReason?: string }[];
      };
      const entry = state.sync.find((s) => s.sourceId === body.source.id);
      expect(entry?.errorReason).toBe("no_mirror");
    } finally {
      await server.dispose();
    }
  });

  test("POST a duplicate origin → 409 (first add reaches onboard, second short-circuits)", async () => {
    const server = await serverWith(stubFetch(repoTar([conformingSkill("foo")])));
    try {
      const first = await postOrigin(server, "https://github.com/a/b");
      expect(first.status).toBe(201);
      const dup = await postOrigin(server, "https://github.com/a/b.git");
      expect(dup.status).toBe(409);
    } finally {
      await server.dispose();
    }
  });

  test("activate / deactivate a known id → 200; delete → 204", async () => {
    const server = await serverWith(stubFetch(repoTar([conformingSkill("foo")])));
    try {
      const add = await postOrigin(server, "https://github.com/a/b");
      const { source } = AddSourceResult.parse(await add.json());
      const id = source.id;

      const off = await server.app.fetch(
        authed(`/api/sources/${id}/deactivate`, { method: "POST" }),
      );
      expect(off.status).toBe(200);
      expect(((await off.json()) as { active: boolean }).active).toBe(false);

      const on = await server.app.fetch(authed(`/api/sources/${id}/activate`, { method: "POST" }));
      expect(on.status).toBe(200);
      expect(((await on.json()) as { active: boolean }).active).toBe(true);

      const del = await server.app.fetch(authed(`/api/sources/${id}`, { method: "DELETE" }));
      expect(del.status).toBe(204);
    } finally {
      await server.dispose();
    }
  });

  test("activate / delete an unknown id → 404", async () => {
    const server = await serverWith(stubFetch([]));
    try {
      const act = await server.app.fetch(authed("/api/sources/nope/activate", { method: "POST" }));
      expect(act.status).toBe(404);
      const del = await server.app.fetch(authed("/api/sources/nope", { method: "DELETE" }));
      expect(del.status).toBe(404);
    } finally {
      await server.dispose();
    }
  });

  test("(#36) DELETE removes the on-disk Mirror dir + GET omits the Source", async () => {
    const server = await serverWith(stubFetch(repoTar([conformingSkill("foo")])));
    try {
      const add = await postOrigin(server, "https://github.com/a/b");
      const { source } = AddSourceResult.parse(await add.json());
      const mirrorRoot = defaultDeployTargets().mirrorRoot(source.id);
      // The add built the Mirror (reachable + conforming).
      expect(existsSync(mirrorRoot)).toBe(true);

      const del = await server.app.fetch(authed(`/api/sources/${source.id}`, { method: "DELETE" }));
      expect(del.status).toBe(204);

      // The on-disk Mirror dir is gone; GET omits the Source.
      expect(existsSync(mirrorRoot)).toBe(false);
      const list = await server.app.fetch(authed("/api/sources"));
      const sources = (await list.json()) as { id: string }[];
      expect(sources.some((s) => s.id === source.id)).toBe(false);
    } finally {
      await server.dispose();
    }
  });

  test("memory-mode boot writes NO sources.json under the Hive home", async () => {
    const server = await serverWith(stubFetch(repoTar([conformingSkill("foo")])));
    try {
      await postOrigin(server, "https://github.com/a/b");
      expect(existsSync(join(runtimeRoot, "sources.json"))).toBe(false);
    } finally {
      await server.dispose();
    }
  });
});
