import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type ExternalSession, MAX_EXTERNAL_SESSION_MS } from "@hive/contract";

export type SessionRegistry = {
  mint(ttlMs?: number): ExternalSession;
  authenticate(token: string): boolean;
  revoke(sessionId: string): boolean;
};

export type SessionRegistryDeps = {
  now(): number;
  randomBytes(size: number): Buffer;
  randomUUID(): string;
};

type SessionRecord = {
  tokenHash: Buffer;
  expiresAt: number;
};

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function productionDeps(): SessionRegistryDeps {
  return { now: Date.now, randomBytes, randomUUID };
}

export function createSessionRegistry(
  deps: SessionRegistryDeps = productionDeps(),
): SessionRegistry {
  const records = new Map<string, SessionRecord>();

  return {
    mint(ttlMs = MAX_EXTERNAL_SESSION_MS) {
      const sessionId = deps.randomUUID();
      const sessionToken = deps.randomBytes(32).toString("base64url");
      const lifetime = Math.min(Math.max(Math.trunc(ttlMs), 1), MAX_EXTERNAL_SESSION_MS);
      const expiresAt = deps.now() + lifetime;
      records.set(sessionId, { tokenHash: hashToken(sessionToken), expiresAt });
      return { sessionId, sessionToken, expiresAt };
    },

    authenticate(token) {
      const candidate = hashToken(token);
      const now = deps.now();
      for (const [sessionId, record] of records) {
        if (record.expiresAt <= now) {
          records.delete(sessionId);
          continue;
        }
        if (timingSafeEqual(candidate, record.tokenHash)) return true;
      }
      return false;
    },

    revoke(sessionId) {
      return records.delete(sessionId);
    },
  };
}
