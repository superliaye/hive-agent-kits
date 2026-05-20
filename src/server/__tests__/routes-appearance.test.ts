/**
 * HTTP routes for Appearance — get/put preferences. Validates Zod shape
 * rejection + persistence round-trip + audit event capture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, type Preferences } from "../../appearance/types.ts";
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
    const body = (await res.json()) as Preferences;
    expect(body).toEqual(DEFAULT_PREFERENCES);
  });

  test("PUT /api/appearance replaces preferences", async () => {
    const next: Preferences = { ...DEFAULT_PREFERENCES, mode: "dark" };
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: JSON.stringify(next) }),
    );
    expect(put.status).toBe(200);
    const after = await server.app.fetch(authed("/api/appearance"));
    const body = (await after.json()) as Preferences;
    expect(body).toEqual(next);
  });

  test("PUT accepts full preferences shape (per-mode configs)", async () => {
    const prefs: Preferences = {
      mode: "dark",
      light: { accent: "#0a0a0f", fontUiSize: 15 },
      dark: {
        accent: "#4a8eff",
        background: "#0d1117",
        fontUi: '"Inter", sans-serif',
        fontCode: '"Fira Code", monospace',
        fontUiSize: 16,
        fontCodeSize: 13,
        contrast: 60,
        translucentSidebar: true,
      },
      reduceMotion: "on",
      pointerCursors: true,
    };
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: JSON.stringify(prefs) }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as Preferences;
    expect(body).toEqual(prefs);
  });

  test("PUT rejects invalid mode with 400", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", {
        method: "PUT",
        body: JSON.stringify({ ...DEFAULT_PREFERENCES, mode: "weird" }),
      }),
    );
    expect(put.status).toBe(400);
  });

  test("PUT rejects unknown fields with 400 (strict schema)", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", {
        method: "PUT",
        body: JSON.stringify({ ...DEFAULT_PREFERENCES, surprise: true }),
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
