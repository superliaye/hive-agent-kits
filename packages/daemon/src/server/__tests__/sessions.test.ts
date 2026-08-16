import { describe, expect, test } from "bun:test";
import { MAX_EXTERNAL_SESSION_MS } from "@hive/contract";
import { createSessionRegistry } from "../sessions.ts";

function registryAt(start: number) {
  let now = start;
  let sequence = 0;
  const registry = createSessionRegistry({
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++sequence),
    randomUUID: () => `018f7f7a-${String(++sequence).padStart(4, "0")}-7abc-8def-0123456789ab`,
  });
  return { registry, advance: (ms: number) => (now += ms) };
}

describe("external session registry", () => {
  test("authenticates a minted token only until its expiry", () => {
    const { registry, advance } = registryAt(1_000);
    const session = registry.mint(60_000);

    expect(registry.authenticate(session.sessionToken)).toBe(true);
    expect(JSON.stringify(registry)).not.toContain(session.sessionToken);
    advance(60_001);
    expect(registry.authenticate(session.sessionToken)).toBe(false);
  });

  test("revokes a session by its opaque id", () => {
    const { registry } = registryAt(1_000);
    const session = registry.mint(60_000);

    expect(registry.revoke(session.sessionId)).toBe(true);
    expect(registry.authenticate(session.sessionToken)).toBe(false);
    expect(registry.revoke(session.sessionId)).toBe(false);
  });

  test("caps requested lifetime at one working day", () => {
    const { registry } = registryAt(1_000);
    const session = registry.mint(MAX_EXTERNAL_SESSION_MS * 2);

    expect(session.expiresAt).toBe(1_000 + MAX_EXTERNAL_SESSION_MS);
  });
});
