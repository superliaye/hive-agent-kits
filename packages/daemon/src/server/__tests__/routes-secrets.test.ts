/**
 * HTTP routes for Secrets (Part 4b). Covers the API-key CRUD surface:
 *   - GET /api/secrets             list configured providers
 *   - POST /api/secrets/:provider/api-key
 *   - DELETE /api/secrets/:provider
 *
 * In-app OAuth login was removed (ADR-0019): the vendor SDKs authenticate from
 * ambient OS login or API-key env vars, so Hive stores API keys only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerHandles } from "../index.ts";

const TOKEN = "test-token";

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

describe("server routes — secrets", () => {
  let bundledRoot: string;
  let runtimeRoot: string;
  let server: ServerHandles;

  beforeEach(async () => {
    bundledRoot = mkdtempSync(join(tmpdir(), "hive-bundled-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    process.env.HIVE_BUNDLED_ROOT = bundledRoot;
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
    mkdirSync(join(bundledRoot, "agents", "root"), { recursive: true });
    writeFileSync(
      join(bundledRoot, "agents", "root", "HARNESS.md"),
      "---\nagentId: root\nbackend: claude-code\ndomain: root\nbindings:\n  skills: []\n  snippets: []\n  tools: []\n  mcp: []\nconfig: {}\n---\n# root\nbody\n",
    );
    server = await createServer({ mode: "memory", token: TOKEN });
  });

  afterEach(async () => {
    await server.dispose();
    delete process.env.HIVE_BUNDLED_ROOT;
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(bundledRoot)) rmSync(bundledRoot, { recursive: true, force: true });
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  // ─── apiKey CRUD ───────────────────────────────────────────────────────

  test("GET /api/secrets returns empty list initially", async () => {
    const res = await server.app.fetch(authed("/api/secrets"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST .../api-key stores; GET /api/secrets includes it", async () => {
    const set = await server.app.fetch(
      authed("/api/secrets/anthropic/api-key", {
        method: "POST",
        body: JSON.stringify({ apiKey: "sk-test" }),
      }),
    );
    expect(set.status).toBe(204);
    const list = await server.app.fetch(authed("/api/secrets"));
    const body = (await list.json()) as Array<{ provider: string; kind: string; status: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ provider: "anthropic", kind: "apiKey", status: "ok" });
  });

  test("POST .../api-key rejects empty body with 400", async () => {
    const res = await server.app.fetch(
      authed("/api/secrets/anthropic/api-key", {
        method: "POST",
        body: JSON.stringify({ apiKey: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("DELETE removes the entry", async () => {
    await server.app.fetch(
      authed("/api/secrets/anthropic/api-key", {
        method: "POST",
        body: JSON.stringify({ apiKey: "sk-test" }),
      }),
    );
    const del = await server.app.fetch(authed("/api/secrets/anthropic", { method: "DELETE" }));
    expect(del.status).toBe(204);
    const list = await server.app.fetch(authed("/api/secrets"));
    expect(await list.json()).toEqual([]);
  });

  test("DELETE on missing provider returns 404", async () => {
    const del = await server.app.fetch(
      authed("/api/secrets/never-configured", { method: "DELETE" }),
    );
    expect(del.status).toBe(404);
  });
});
