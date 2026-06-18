// HTTP route test for GET /api/backends/readiness. Memory mode reports both
// backends as not_installed, but the readiness projection still lists one row
// per probeable backend with its mapped provider + auth state. Setting an API
// key for a provider flips that backend's row to api-key; the sibling stays
// cli-managed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendReadiness } from "../../backend-readiness/index.ts";
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

describe("server routes — backends readiness", () => {
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

  test("returns one row per probeable backend with mapped provider + cli-managed auth when no secret is set", async () => {
    const res = await server.app.fetch(authed("/api/backends/readiness"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = BackendReadiness.array().parse(body);
    expect(rows).toHaveLength(2);

    const claude = rows.find((r) => r.backend === "claude-code");
    const codex = rows.find((r) => r.backend === "codex");
    expect(claude?.provider).toBe("anthropic");
    expect(codex?.provider).toBe("openai-codex");
    // No secret stored → both cli-managed, no stored metadata.
    expect(claude?.auth.state).toBe("cli-managed");
    expect(claude?.auth.stored).toBeUndefined();
    expect(codex?.auth.state).toBe("cli-managed");
    expect(codex?.auth.stored).toBeUndefined();
  });

  test("after POST /api/secrets/anthropic/api-key, claude-code is api-key while codex stays cli-managed", async () => {
    const set = await server.app.fetch(
      authed("/api/secrets/anthropic/api-key", {
        method: "POST",
        body: JSON.stringify({ apiKey: "sk-test-key" }),
      }),
    );
    expect(set.status).toBe(204);

    const res = await server.app.fetch(authed("/api/backends/readiness"));
    expect(res.status).toBe(200);
    const rows = BackendReadiness.array().parse(await res.json());

    const claude = rows.find((r) => r.backend === "claude-code");
    const codex = rows.find((r) => r.backend === "codex");
    expect(claude?.auth.state).toBe("api-key");
    expect(claude?.auth.stored?.kind).toBe("apiKey");
    expect(codex?.auth.state).toBe("cli-managed");
    expect(codex?.auth.stored).toBeUndefined();
  });
});
