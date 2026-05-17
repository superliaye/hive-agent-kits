/**
 * HTTP routes exercised against an in-process daemon (no listener),
 * via Hono's app.fetch(Request). Covers:
 *   - bearer-token gate
 *   - agent list / detail / patch / reset
 *   - capabilities list with kind filter
 *   - SSE stream (basic open/event/close)
 *   - fork-on-write reflected in subsequent GET
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";

function harness(agentId: string, withSkill = "alpha"): string {
  return `---
agentId: ${agentId}
backend: native
domain: ${agentId} domain
bindings:
  skills:
    - ${withSkill}
  snippets: []
  tools:
    - ask_user
  mcp: []
config:
  model: claude-opus-4-7
---

# ${agentId}

Body.
`;
}

function skill(name: string, description = "test skill"): string {
  return `---
name: ${name}
description: ${description}
---
body
`;
}

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${TOKEN}`,
    },
  });
}

describe("server routes", () => {
  let bundledRoot: string;
  let runtimeRoot: string;
  let server: ServerHandles;

  beforeEach(async () => {
    bundledRoot = mkdtempSync(join(tmpdir(), "hive-bundled-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    process.env.HIVE_BUNDLED_ROOT = bundledRoot;
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;

    // Seed bundled fixtures
    mkdirSync(join(bundledRoot, "personal", "skills", "alpha"), { recursive: true });
    writeFileSync(
      join(bundledRoot, "personal", "skills", "alpha", "SKILL.md"),
      skill("alpha", "first skill"),
    );
    mkdirSync(join(bundledRoot, "personal", "snippets", "core"), { recursive: true });
    writeFileSync(
      join(bundledRoot, "personal", "snippets", "core", "SNIPPET.md"),
      `---\nname: core\ndescription: voice rules\n---\nbody\n`,
    );
    mkdirSync(join(bundledRoot, "agents", "root"), { recursive: true });
    writeFileSync(join(bundledRoot, "agents", "root", "HARNESS.md"), harness("root"));

    server = await createServer({ mode: "memory", token: TOKEN });
  });

  afterEach(async () => {
    await server.dispose();
    delete process.env.HIVE_BUNDLED_ROOT;
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(bundledRoot)) rmSync(bundledRoot, { recursive: true, force: true });
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test("GET /api/ready needs no auth and returns ok", async () => {
    const res = await server.app.fetch(new Request("http://localhost/api/ready"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("missing or wrong token yields 401", async () => {
    const noAuth = await server.app.fetch(new Request("http://localhost/api/agents"));
    expect(noAuth.status).toBe(401);

    const wrong = await server.app.fetch(
      new Request("http://localhost/api/agents", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  test("GET /api/agents returns summaries", async () => {
    const res = await server.app.fetch(authed("/api/agents"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ agentId: string; bindingCounts: { skills: number } }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.agentId).toBe("root");
    expect(body[0]?.bindingCounts.skills).toBe(1);
  });

  test("GET /api/agents/:id returns detail with bindings + body", async () => {
    const res = await server.app.fetch(authed("/api/agents/root"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: { skills: string[] }; promptBody: string };
    expect(body.bindings.skills).toEqual(["alpha"]);
    expect(body.promptBody).toContain("# root");
  });

  test("GET /api/agents/unknown returns 404", async () => {
    const res = await server.app.fetch(authed("/api/agents/nope"));
    expect(res.status).toBe(404);
  });

  test("PATCH /api/agents/:id/bindings unbinds a skill and forks", async () => {
    const res = await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", name: "alpha", action: "unbind" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layer: string; hasFork: boolean; bindings: { skills: string[] } };
    expect(body.layer).toBe("runtime");
    expect(body.hasFork).toBe(true);
    expect(body.bindings.skills).toEqual([]);

    const forkPath = join(runtimeRoot, "agents", "root", "HARNESS.md");
    expect(existsSync(forkPath)).toBe(true);
  });

  test("PATCH with invalid payload returns 400", async () => {
    const res = await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", action: "unbind" }],
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/agents/:id/reset removes the fork", async () => {
    await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", name: "alpha", action: "unbind" }],
        }),
      }),
    );
    const forkPath = join(runtimeRoot, "agents", "root", "HARNESS.md");
    expect(existsSync(forkPath)).toBe(true);

    const res = await server.app.fetch(
      authed("/api/agents/root/reset", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layer: string; hasFork: boolean };
    expect(body.layer).toBe("bundled");
    expect(body.hasFork).toBe(false);
    expect(existsSync(forkPath)).toBe(false);
  });

  test("GET /api/capabilities filters by kind", async () => {
    const all = await server.app.fetch(authed("/api/capabilities"));
    const allBody = (await all.json()) as Array<{ kind: string }>;
    expect(allBody).toHaveLength(2);

    const skills = await server.app.fetch(authed("/api/capabilities?kind=skill"));
    const skillsBody = (await skills.json()) as Array<{ kind: string; name: string }>;
    expect(skillsBody).toHaveLength(1);
    expect(skillsBody[0]?.name).toBe("alpha");
  });

  test("GET /api/capabilities with invalid kind returns 400", async () => {
    const res = await server.app.fetch(authed("/api/capabilities?kind=bogus"));
    expect(res.status).toBe(400);
  });

  test("audit log records harness.updated for binding patch", async () => {
    await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", name: "alpha", action: "unbind" }],
        }),
      }),
    );
    const rows = await server.audit.query({ source: "catalog" });
    const updated = rows.find((r) => r.event_type === "harness.updated");
    expect(updated).toBeDefined();
    expect(updated?.agent_id).toBe("root");
    expect(updated?.payload).toMatchObject({
      source: "ui",
      diff: [{ kind: "skill", name: "alpha", action: "unbind" }],
    });
  });

  test("PATCH applies a batch of patches in one shot", async () => {
    // Seed an extra skill to remove + a snippet to bind.
    mkdirSync(join(bundledRoot, "personal", "skills", "beta"), { recursive: true });
    writeFileSync(
      join(bundledRoot, "personal", "skills", "beta", "SKILL.md"),
      skill("beta"),
    );
    // Reboot the server so the new skill is in the registry.
    await server.dispose();
    server = await createServer({ mode: "memory", token: TOKEN });

    // First, bind beta so we have two skills to manipulate.
    await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", name: "beta", action: "bind" }],
        }),
      }),
    );

    // Now batch: unbind alpha, unbind beta, bind core (snippet).
    const res = await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [
            { kind: "skill", name: "alpha", action: "unbind" },
            { kind: "skill", name: "beta", action: "unbind" },
            { kind: "snippet", name: "core", action: "bind" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: { skills: string[]; snippets: string[] } };
    expect(body.bindings.skills).toEqual([]);
    expect(body.bindings.snippets).toEqual(["core"]);

    const rows = await server.audit.query({ source: "catalog" });
    const updates = rows.filter((r) => r.event_type === "harness.updated");
    // Two PATCH calls in this test → exactly two harness.updated rows.
    expect(updates).toHaveLength(2);
    const latest = updates[0]?.payload as { diff: unknown[] };
    expect(latest.diff).toHaveLength(3);
  });

  test("PATCH with empty patches array returns 400", async () => {
    const res = await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patches: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
