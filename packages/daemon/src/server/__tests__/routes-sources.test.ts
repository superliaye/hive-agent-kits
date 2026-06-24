/**
 * HTTP routes for the Sources registry (ADR-0023). Covers the five verbs and
 * their pinned statuses:
 *   - GET    /api/sources                 list (200)
 *   - POST   /api/sources                 add (400 malformed, 201 valid, 409 dup)
 *   - POST   /api/sources/:id/activate    (200, 404 unknown)
 *   - POST   /api/sources/:id/deactivate  (200)
 *   - DELETE /api/sources/:id             (204, 404 unknown)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

describe("server routes — sources", () => {
  let runtimeRoot: string;
  let server: ServerHandles;

  beforeEach(async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "hive-runtime-"));
    process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
    server = await createServer({ mode: "memory", token: TOKEN });
  });

  afterEach(async () => {
    await server.dispose();
    delete process.env.HIVE_RUNTIME_ROOT;
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test("GET /api/sources returns empty list initially", async () => {
    const res = await server.app.fetch(authed("/api/sources"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST /api/sources with malformed body → 400", async () => {
    const res = await server.app.fetch(
      authed("/api/sources", { method: "POST", body: JSON.stringify({ origin: "mailto:x@y" }) }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/sources with an ftp URL → 400", async () => {
    const res = await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ origin: "ftp://example.com/repo" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/sources with a valid https origin → 201", async () => {
    const res = await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ origin: "https://github.com/a/b" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; origin: string; active: boolean };
    expect(body.active).toBe(true);
    expect(body.id).not.toBe(body.origin);
  });

  test("POST a duplicate origin → 409", async () => {
    await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ origin: "https://github.com/a/b" }),
      }),
    );
    const dup = await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ origin: "https://github.com/a/b.git" }),
      }),
    );
    expect(dup.status).toBe(409);
  });

  test("activate / deactivate a known id → 200; delete → 204", async () => {
    const add = await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ origin: "https://github.com/a/b" }),
      }),
    );
    const { id } = (await add.json()) as { id: string };

    const off = await server.app.fetch(authed(`/api/sources/${id}/deactivate`, { method: "POST" }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as { active: boolean }).active).toBe(false);

    const on = await server.app.fetch(authed(`/api/sources/${id}/activate`, { method: "POST" }));
    expect(on.status).toBe(200);
    expect(((await on.json()) as { active: boolean }).active).toBe(true);

    const del = await server.app.fetch(authed(`/api/sources/${id}`, { method: "DELETE" }));
    expect(del.status).toBe(204);
  });

  test("activate / delete an unknown id → 404", async () => {
    const act = await server.app.fetch(authed("/api/sources/nope/activate", { method: "POST" }));
    expect(act.status).toBe(404);
    const del = await server.app.fetch(authed("/api/sources/nope", { method: "DELETE" }));
    expect(del.status).toBe(404);
  });

  test("memory-mode boot writes NO sources.json under the Hive home", async () => {
    await server.app.fetch(
      authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ origin: "https://github.com/a/b" }),
      }),
    );
    expect(existsSync(join(runtimeRoot, "sources.json"))).toBe(false);
  });
});
