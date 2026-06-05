/**
 * HTTP routes for Secrets (Part 4b). Covers:
 *   - GET /api/secrets             list configured providers
 *   - GET /api/secrets/oauth-providers   list pi-ai OAuth providers
 *   - POST /api/secrets/:provider/api-key
 *   - DELETE /api/secrets/:provider
 *   - POST /api/secrets/:provider/oauth/login   SSE happy + error paths
 *
 * OAuth happy path is tested via a registered custom OAuth provider in
 * pi-ai — no real browser opens, no real network call. The custom provider
 * invokes the caller's `onAuth` + returns stubbed credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OAuthCredentials,
  type OAuthProviderInterface,
  registerOAuthProvider,
  unregisterOAuthProvider,
} from "@earendil-works/pi-ai/oauth";
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

async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text();
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    out.push({ event, data: JSON.parse(data) });
  }
  return out;
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

  // ─── OAuth provider list ───────────────────────────────────────────────

  test("GET /api/secrets/oauth-providers lists pi-ai's built-in providers", async () => {
    const res = await server.app.fetch(authed("/api/secrets/oauth-providers"));
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; name: string }>;
    // pi-ai ships Anthropic, OpenAI Codex, and GitHub Copilot OAuth providers.
    const ids = list.map((p) => p.id);
    expect(ids).toContain("anthropic");
  });

  // ─── OAuth login SSE ───────────────────────────────────────────────────

  test("OAuth login happy path: stub provider yields auth event then done", async () => {
    const credentials: OAuthCredentials = {
      access: "acc-stub",
      refresh: "ref-stub",
      expires: 9_000_000_000_000,
    };
    const stubProvider: OAuthProviderInterface = {
      id: "stub-success",
      name: "Stub Success",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://example.test/auth", instructions: "follow the link" });
        return credentials;
      },
      async refreshToken(c) {
        return c;
      },
      getApiKey() {
        return "sk-from-stub";
      },
    };
    registerOAuthProvider(stubProvider);
    try {
      const res = await server.app.fetch(
        authed("/api/secrets/stub-success/oauth/login", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const events = await readSSE(res);
      const names = events.map((e) => e.event);
      expect(names).toContain("auth");
      expect(names[names.length - 1]).toBe("done");

      const authEvent = events.find((e) => e.event === "auth")?.data as { url: string };
      expect(authEvent.url).toBe("https://example.test/auth");

      // Credentials should now be in the store.
      const list = await server.app.fetch(authed("/api/secrets"));
      const stored = (await list.json()) as Array<{ provider: string; kind: string }>;
      const oauth = stored.find((s) => s.provider === "stub-success");
      expect(oauth).toMatchObject({ kind: "oauth" });
    } finally {
      unregisterOAuthProvider("stub-success");
    }
  });

  test("OAuth login: callback-server provider completes without manual-code abort (ChatGPT/Anthropic regression)", async () => {
    // pi-ai's anthropic/openai-codex providers race a supplied onManualCodeInput
    // against their loopback callback server: a rejecting manual stub cancels the
    // wait and aborts the login, tearing down the loopback before the browser
    // callback lands. Hive must therefore NOT pass onManualCodeInput. This stub
    // mirrors that race and fails the login if it receives one.
    const credentials: OAuthCredentials = {
      access: "acc-cb",
      refresh: "ref-cb",
      expires: 9_000_000_000_000,
    };
    const stubProvider: OAuthProviderInterface = {
      id: "stub-callback-server",
      name: "Stub Callback Server",
      usesCallbackServer: true,
      async login(callbacks) {
        callbacks.onAuth({ url: "https://example.test/auth" });
        if (callbacks.onManualCodeInput) {
          await callbacks.onManualCodeInput();
        }
        return credentials;
      },
      async refreshToken(c) {
        return c;
      },
      getApiKey() {
        return "sk-cb";
      },
    };
    registerOAuthProvider(stubProvider);
    try {
      const res = await server.app.fetch(
        authed("/api/secrets/stub-callback-server/oauth/login", { method: "POST" }),
      );
      const events = await readSSE(res);
      const names = events.map((e) => e.event);
      expect(names).toContain("auth");
      expect(names).not.toContain("error");
      expect(names[names.length - 1]).toBe("done");
    } finally {
      unregisterOAuthProvider("stub-callback-server");
    }
  });

  test("OAuth login is single-flight: a concurrent login is refused while one is active", async () => {
    // Callback-server providers bind a fixed loopback port, so only one login
    // can run at a time. A gated stub stays "in flight" so we can fire a second
    // request and assert it's refused clearly instead of starting a doomed
    // second server.
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => {
      signalStarted = r;
    });
    const credentials: OAuthCredentials = {
      access: "acc-sf",
      refresh: "ref-sf",
      expires: 9_000_000_000_000,
    };
    const stubProvider: OAuthProviderInterface = {
      id: "stub-blocking",
      name: "Stub Blocking",
      usesCallbackServer: true,
      async login(callbacks) {
        callbacks.onAuth({ url: "https://example.test/auth" });
        signalStarted();
        await gate;
        return credentials;
      },
      async refreshToken(c) {
        return c;
      },
      getApiKey() {
        return "sk-sf";
      },
    };
    registerOAuthProvider(stubProvider);
    try {
      const resA = await server.app.fetch(
        authed("/api/secrets/stub-blocking/oauth/login", { method: "POST" }),
      );
      const aEvents = readSSE(resA); // begin consuming → runs the gated login
      await started; // login A now owns the single-flight slot

      const resB = await server.app.fetch(
        authed("/api/secrets/stub-blocking/oauth/login", { method: "POST" }),
      );
      const bEvents = await readSSE(resB);
      const bErr = bEvents.find((e) => e.event === "error");
      expect(bErr).toBeDefined();
      expect((bErr?.data as { message: string }).message.toLowerCase()).toContain(
        "already in progress",
      );

      releaseGate();
      const aResolved = await aEvents;
      expect(aResolved.map((e) => e.event).at(-1)).toBe("done");
    } finally {
      releaseGate();
      unregisterOAuthProvider("stub-blocking");
    }
  });

  test("OAuth login error: unknown provider emits error event", async () => {
    const res = await server.app.fetch(
      authed("/api/secrets/never-registered-zzz/oauth/login", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const events = await readSSE(res);
    const err = events.find((e) => e.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { message: string }).message.toLowerCase()).toContain(
      "unknown oauth provider",
    );
  });

  test("OAuth login error: provider that needs interactive prompt is refused", async () => {
    const stubProvider: OAuthProviderInterface = {
      id: "stub-prompt",
      name: "Stub Prompt",
      async login(callbacks) {
        const value = await callbacks.onPrompt({ message: "enter code" });
        return {
          access: value,
          refresh: "r",
          expires: 9_000_000_000_000,
        };
      },
      async refreshToken(c) {
        return c;
      },
      getApiKey() {
        return "sk-x";
      },
    };
    registerOAuthProvider(stubProvider);
    try {
      const res = await server.app.fetch(
        authed("/api/secrets/stub-prompt/oauth/login", { method: "POST" }),
      );
      const events = await readSSE(res);
      const err = events.find((e) => e.event === "error");
      expect(err).toBeDefined();
      expect((err?.data as { message: string }).message.toLowerCase()).toContain("prompt");
    } finally {
      unregisterOAuthProvider("stub-prompt");
    }
  });
});
