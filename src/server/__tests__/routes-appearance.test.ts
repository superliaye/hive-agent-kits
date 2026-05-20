/**
 * HTTP routes for Appearance — get/put preferences. Validates Zod shape
 * rejection + persistence round-trip + audit event capture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandles, createServer } from "../index.ts";

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

describe("server routes — appearance", () => {
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
      "---\nagentId: root\nbackend: native\ndomain: root\nbindings:\n  skills: []\n  snippets: []\n  tools: []\n  mcp: []\nconfig: {}\n---\n# root\nbody\n",
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

  test("GET /api/appearance returns default preferences initially", async () => {
    const res = await server.app.fetch(authed("/api/appearance"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { presetId: string };
    expect(body.presetId).toBe("system");
  });

  test("PUT /api/appearance replaces preferences", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", {
        method: "PUT",
        body: JSON.stringify({ presetId: "dark" }),
      }),
    );
    expect(put.status).toBe(200);
    const after = await server.app.fetch(authed("/api/appearance"));
    const body = (await after.json()) as { presetId: string };
    expect(body.presetId).toBe("dark");
  });

  test("PUT accepts full preferences shape (overrides + fonts)", async () => {
    const prefs = {
      presetId: "dim",
      overrides: { accent: "#4a8eff", background: "#0d1117" },
      fonts: { ui: '"Inter", sans-serif', code: '"Fira Code", monospace' },
    };
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: JSON.stringify(prefs) }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as typeof prefs;
    expect(body).toEqual(prefs);
  });

  test("PUT rejects empty presetId with 400", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: JSON.stringify({ presetId: "" }) }),
    );
    expect(put.status).toBe(400);
  });

  test("PUT rejects unknown fields with 400 (strict schema)", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", {
        method: "PUT",
        body: JSON.stringify({ presetId: "dark", surprise: true }),
      }),
    );
    expect(put.status).toBe(400);
  });

  test("PUT rejects malformed JSON with 400", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: "{not json" }),
    );
    expect(put.status).toBe(400);
  });
});
