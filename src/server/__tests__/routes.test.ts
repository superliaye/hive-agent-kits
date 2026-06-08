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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const body = (await res.json()) as Array<{
      agentId: string;
      bindingCounts: { skills: number };
    }>;
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
    const body = (await res.json()) as {
      layer: string;
      hasFork: boolean;
      bindings: { skills: string[] };
    };
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

    const res = await server.app.fetch(authed("/api/agents/root/reset", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layer: string; hasFork: boolean };
    expect(body.layer).toBe("bundled");
    expect(body.hasFork).toBe(false);
    expect(existsSync(forkPath)).toBe(false);
  });

  test("GET /api/agents/:id/model-pref returns null when unset", async () => {
    const res = await server.app.fetch(authed("/api/agents/root/model-pref"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: null });
  });

  test("PUT then GET /api/agents/:id/model-pref round-trips the choice", async () => {
    const put = await server.app.fetch(
      authed("/api/agents/root/model-pref", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai-codex/gpt-5.2" }),
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ model: "openai-codex/gpt-5.2" });

    const get = await server.app.fetch(authed("/api/agents/root/model-pref"));
    expect(await get.json()).toEqual({ model: "openai-codex/gpt-5.2" });
  });

  test("PUT /api/agents/:id/model-pref rejects a malformed model with 400", async () => {
    const res = await server.app.fetch(
      authed("/api/agents/root/model-pref", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "no-slash" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("model-pref endpoints 404 for an unknown agent", async () => {
    const get = await server.app.fetch(authed("/api/agents/ghost/model-pref"));
    expect(get.status).toBe(404);
    const put = await server.app.fetch(
      authed("/api/agents/ghost/model-pref", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-opus-4-7" }),
      }),
    );
    expect(put.status).toBe(404);
  });

  test("GET /api/models lists models for configured + routable providers only", async () => {
    // Nothing configured yet → empty list.
    const empty = await server.app.fetch(authed("/api/models"));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    // anthropic + openai-codex are routable; openai stays unconfigured;
    // "not-a-real-provider" is configured but unroutable.
    for (const provider of ["anthropic", "openai-codex", "not-a-real-provider"]) {
      await server.app.fetch(
        authed(`/api/secrets/${provider}/api-key`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: "x" }),
        }),
      );
    }

    const res = await server.app.fetch(authed("/api/models"));
    const models = (await res.json()) as Array<{ provider: string; model: string }>;
    const providers = new Set(models.map((m) => m.provider));
    expect(providers.has("anthropic")).toBe(true); // configured + routable
    expect(providers.has("openai-codex")).toBe(true); // ChatGPT, routable after the fix
    expect(providers.has("openai")).toBe(false); // routable but not configured
    expect(providers.has("not-a-real-provider")).toBe(false); // configured but unroutable
    expect(models.every((m) => m.model.includes("/"))).toBe(true);
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

  test("GET /api/capabilities exposes manifest.source as wire.upstream", async () => {
    // Seed a skill with a `source:` block (vendored from an upstream).
    mkdirSync(join(bundledRoot, "personal", "skills", "vendored"), { recursive: true });
    writeFileSync(
      join(bundledRoot, "personal", "skills", "vendored", "SKILL.md"),
      `---
name: vendored
description: vendored skill
source:
  url: github.com/example/repo
  ref: "1.0.0"
  fetchedAt: 2026-05-17
---
body
`,
    );
    // Rebuild the server so the new file is picked up.
    await server.dispose();
    server = await createServer({ mode: "memory", token: TOKEN });

    const res = await server.app.fetch(authed("/api/capabilities?kind=skill"));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      name: string;
      upstream?: { url: string; ref: string };
    }>;
    const vendored = rows.find((r) => r.name === "vendored");
    expect(vendored?.upstream).toEqual({ url: "github.com/example/repo", ref: "1.0.0" });
    // The plain `alpha` skill (no source: block) must omit upstream entirely.
    const plain = rows.find((r) => r.name === "alpha");
    expect(plain).toBeDefined();
    expect(plain?.upstream).toBeUndefined();
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
    writeFileSync(join(bundledRoot, "personal", "skills", "beta", "SKILL.md"), skill("beta"));
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

  test("GET /api/audit returns rows from the running audit log", async () => {
    // Mutate state to generate an audit row, then query for it.
    await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", name: "alpha", action: "unbind" }],
        }),
      }),
    );

    const res = await server.app.fetch(authed("/api/audit?source=catalog"));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      source: string;
      event_type: string;
      agent_id: string | null;
      payload: Record<string, unknown>;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "catalog")).toBe(true);
    const updated = rows.find((r) => r.event_type === "harness.updated");
    expect(updated).toBeDefined();
    expect(updated?.agent_id).toBe("root");
  });

  test("GET /api/audit filters by event_type", async () => {
    await server.app.fetch(
      authed("/api/agents/root/bindings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patches: [{ kind: "skill", name: "alpha", action: "unbind" }],
        }),
      }),
    );
    const res = await server.app.fetch(
      authed("/api/audit?source=catalog&event_type=harness.updated&limit=10"),
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ event_type: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.event_type === "harness.updated")).toBe(true);
  });

  test("GET /api/audit rejects unknown query keys", async () => {
    const res = await server.app.fetch(authed("/api/audit?bogus=true"));
    expect(res.status).toBe(400);
  });

  test("GET /api/audit rejects invalid source enum", async () => {
    const res = await server.app.fetch(authed("/api/audit?source=not-a-source"));
    expect(res.status).toBe(400);
  });

  test("GET /api/events fans out a single emit to multiple concurrent clients", async () => {
    // The SSE handler attaches per-stream listeners onto the same registry
    // and catalog emitters. One emit must deliver to every connected stream.
    // Without this test, removing the disposer cleanup or accidentally
    // sharing one listener across clients would go unnoticed.

    async function readSSEUntil(
      res: Response,
      predicate: (event: string, data: string) => boolean,
      timeoutMs: number,
    ): Promise<{ event: string; data: string } | null> {
      if (!res.body) return null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + timeoutMs;
      let buf = "";
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), 250),
          ),
        ]);
        if (done) break;
        if (value) buf += decoder.decode(value, { stream: true });
        // SSE frames are blank-line-terminated.
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const eventLine = frame.split(/\r?\n/).find((l) => l.startsWith("event: "));
          const dataLine = frame.split(/\r?\n/).find((l) => l.startsWith("data: "));
          const event = eventLine?.slice("event: ".length) ?? "";
          const data = dataLine?.slice("data: ".length) ?? "";
          if (predicate(event, data)) {
            await reader.cancel();
            return { event, data };
          }
        }
      }
      await reader.cancel();
      return null;
    }

    // Open two concurrent SSE streams. Hono's streamSSE returns a Response
    // whose body is a ReadableStream — perfect for fan-out verification.
    const stream1 = await server.app.fetch(
      new Request(`http://localhost/api/events?token=${TOKEN}`),
    );
    const stream2 = await server.app.fetch(
      new Request(`http://localhost/api/events?token=${TOKEN}`),
    );
    expect(stream1.status).toBe(200);
    expect(stream2.status).toBe(200);

    // Trigger a single mutation that produces one harness.updated event.
    // Both listeners should receive it.
    const [a, b, _patch] = await Promise.all([
      readSSEUntil(stream1, (e) => e === "catalog.harness.updated", 5000),
      readSSEUntil(stream2, (e) => e === "catalog.harness.updated", 5000),
      server.app.fetch(
        authed("/api/agents/root/bindings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            patches: [{ kind: "skill", name: "alpha", action: "unbind" }],
          }),
        }),
      ),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.event).toBe("catalog.harness.updated");
    expect(b?.event).toBe("catalog.harness.updated");
    // Both clients should see structurally identical payloads.
    expect(a?.data).toBe(b?.data);
  });
});
