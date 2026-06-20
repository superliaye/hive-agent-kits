/**
 * HTTP routes for `/api/appearance` — get/put preferences. Post-fold:
 * the route is a thin wrapper over `config.get("appearance")` and
 * `config.set("appearance", …)`. Tests verify shape validation +
 * round-trip + that the daemon doesn't accept malformed payloads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppearanceConfig } from "@hive/theming/schema";
import { APP_CONFIG_DEFAULTS } from "../../config/schema.ts";
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

describe("server routes — appearance (via Config)", () => {
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

  test("GET /api/appearance returns the config appearance subtree initially", async () => {
    const res = await server.app.fetch(authed("/api/appearance"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AppearanceConfig;
    expect(body).toEqual(APP_CONFIG_DEFAULTS.appearance);
  });

  test("PUT /api/appearance writes through Config", async () => {
    const next: AppearanceConfig = { ...APP_CONFIG_DEFAULTS.appearance, mode: "dark" };
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: JSON.stringify(next) }),
    );
    expect(put.status).toBe(200);
    const after = await server.app.fetch(authed("/api/appearance"));
    const body = (await after.json()) as AppearanceConfig;
    expect(body).toEqual(next);
    // Config got it too — independent reach-through.
    expect(server.config.get("appearance")).toEqual(next);
  });

  test("PUT accepts the full appearance shape (per-mode configs + a11y)", async () => {
    const prefs: AppearanceConfig = {
      mode: "dark",
      light: { accent: "#0a0a0f", fontUiSize: 15 },
      dark: {
        themeId: "dracula",
        accent: "#bd93f9",
        background: "#282a36",
        fontUi: '"Inter", sans-serif',
        fontCode: '"Fira Code", monospace',
        fontUiSize: 16,
        fontCodeSize: 13,
        contrast: 60,
        translucentSidebar: true,
      },
      reduceMotion: "on",
      pointerCursors: true,
      useSystemAccent: false,
    };
    const put = await server.app.fetch(
      authed("/api/appearance", { method: "PUT", body: JSON.stringify(prefs) }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as AppearanceConfig;
    expect(body).toEqual(prefs);
  });

  test("PUT rejects invalid mode with 400", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", {
        method: "PUT",
        body: JSON.stringify({ ...APP_CONFIG_DEFAULTS.appearance, mode: "weird" }),
      }),
    );
    expect(put.status).toBe(400);
  });

  test("PUT rejects unknown fields with 400 (strict schema)", async () => {
    const put = await server.app.fetch(
      authed("/api/appearance", {
        method: "PUT",
        body: JSON.stringify({ ...APP_CONFIG_DEFAULTS.appearance, surprise: true }),
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
