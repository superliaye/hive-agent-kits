/**
 * HTTP routes for `/api/developer` — get/put the developer config slice. A thin
 * wrapper over `config.get("developer")` / `config.set("developer", …)`, mirroring
 * the appearance route. Verifies the round-trip + Zod validation at the boundary.
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

describe("server routes — developer (via Config)", () => {
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

  test("GET /api/developer returns allowRealHomeDeploy:false by default", async () => {
    const res = await server.app.fetch(authed("/api/developer"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowRealHomeDeploy: false });
  });

  test("PUT true persists and a subsequent GET returns true (round-trip)", async () => {
    const put = await server.app.fetch(
      authed("/api/developer", {
        method: "PUT",
        body: JSON.stringify({ allowRealHomeDeploy: true }),
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ allowRealHomeDeploy: true });

    const get = await server.app.fetch(authed("/api/developer"));
    expect(await get.json()).toEqual({ allowRealHomeDeploy: true });
    // Config got it too — independent reach-through.
    expect(server.config.get("developer")).toEqual({ allowRealHomeDeploy: true });
  });

  test("PUT rejects a non-boolean with 400", async () => {
    const put = await server.app.fetch(
      authed("/api/developer", {
        method: "PUT",
        body: JSON.stringify({ allowRealHomeDeploy: "yes" }),
      }),
    );
    expect(put.status).toBe(400);
  });

  test("PUT rejects unknown fields is not required (non-strict), but missing key is rejected", async () => {
    const put = await server.app.fetch(
      authed("/api/developer", { method: "PUT", body: JSON.stringify({}) }),
    );
    expect(put.status).toBe(400);
  });

  test("PUT rejects malformed JSON with 400", async () => {
    const put = await server.app.fetch(
      authed("/api/developer", { method: "PUT", body: "{not json" }),
    );
    expect(put.status).toBe(400);
  });
});
