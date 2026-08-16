import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type ServerHandles } from "../index.ts";
import { createSessionRegistry } from "../sessions.ts";

const durableToken = "durable-test-token";

function request(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

describe("external session routes", () => {
  let server: ServerHandles;

  beforeEach(async () => {
    server = await createServer({ mode: "memory", token: durableToken });
  });

  afterEach(async () => {
    await server.dispose();
  });

  test("durable credential mints a session that authenticates ordinary API calls", async () => {
    const minted = await server.app.fetch(
      request("/api/external-sessions", durableToken, { method: "POST" }),
    );

    expect(minted.status).toBe(201);
    const session = (await minted.json()) as {
      sessionId: string;
      sessionToken: string;
      expiresAt: number;
    };
    expect(session.sessionToken).not.toBe(durableToken);

    const state = await server.app.fetch(request("/api/kit/state", session.sessionToken));
    expect(state.status).toBe(200);
  });

  test("a session cannot mint another session", async () => {
    const minted = await server.app.fetch(
      request("/api/external-sessions", durableToken, { method: "POST" }),
    );
    const session = (await minted.json()) as { sessionToken: string };

    const nested = await server.app.fetch(
      request("/api/external-sessions", session.sessionToken, { method: "POST" }),
    );
    expect(nested.status).toBe(403);
    expect(await nested.json()).toEqual({ error: "durable credential required" });
  });

  test("durable credential revokes a session", async () => {
    const minted = await server.app.fetch(
      request("/api/external-sessions", durableToken, { method: "POST" }),
    );
    const session = (await minted.json()) as { sessionId: string; sessionToken: string };

    const revoked = await server.app.fetch(
      request(`/api/external-sessions/${session.sessionId}`, durableToken, { method: "DELETE" }),
    );
    expect(revoked.status).toBe(204);
    expect((await server.app.fetch(request("/api/kit/state", session.sessionToken))).status).toBe(
      401,
    );
  });

  test("readiness counts live sessions and observes revocation", async () => {
    const minted = await server.app.fetch(
      request("/api/external-sessions", durableToken, { method: "POST" }),
    );
    const session = (await minted.json()) as { sessionId: string };

    const active = await server.app.fetch(request("/api/ready", durableToken));
    expect(await active.json()).toMatchObject({ activeExternalSessions: 1 });

    await server.app.fetch(
      request(`/api/external-sessions/${session.sessionId}`, durableToken, { method: "DELETE" }),
    );
    const inactive = await server.app.fetch(request("/api/ready", durableToken));
    expect(await inactive.json()).toMatchObject({ activeExternalSessions: 0 });
  });

  test("active session count prunes expired sessions", () => {
    let now = 1_000;
    const registry = createSessionRegistry({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 7),
      randomUUID: () => "018f7f7a-1234-7abc-8def-0123456789ab",
    });

    const session = registry.mint(50);
    expect(registry.activeCount()).toBe(1);
    now = session.expiresAt;
    expect(registry.activeCount()).toBe(0);
  });
});
