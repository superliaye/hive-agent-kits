import { describe, expect, test } from "bun:test";
import { createSecretsStore } from "../store.ts";
import {
  SECRETS_FILE_VERSION,
  type SecretEntry,
  type SecretEvents,
  type SecretsFile,
} from "../types.ts";

const EMPTY: SecretsFile = { version: SECRETS_FILE_VERSION, secrets: {} };

const FIXED_NOW = 1_730_000_000_000;
const now = () => FIXED_NOW;

const oauthEntry: SecretEntry = {
  kind: "oauth",
  credentials: { access: "acc-1", refresh: "ref-1", expires: FIXED_NOW + 3600_000 },
  addedAt: FIXED_NOW,
};

const apiKeyEntry: SecretEntry = {
  kind: "apiKey",
  apiKey: "sk-test",
  addedAt: FIXED_NOW,
};

function collectEvents(emitter: ReturnType<typeof createSecretsStore>["events"]) {
  const log: Array<[keyof SecretEvents, SecretEvents[keyof SecretEvents]]> = [];
  emitter.on("secret.read", (e) => {
    log.push(["secret.read", e]);
  });
  emitter.on("secret.write", (e) => {
    log.push(["secret.write", e]);
  });
  emitter.on("secret.refresh", (e) => {
    log.push(["secret.refresh", e]);
  });
  emitter.on("secret.remove", (e) => {
    log.push(["secret.remove", e]);
  });
  return log;
}

describe("createSecretsStore", () => {
  test("set then get returns the stored entry", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("anthropic", oauthEntry);
    expect(await store.get("anthropic")).toEqual(oauthEntry);
  });

  test("get on missing provider returns undefined and emits no event", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    const log = collectEvents(store.events);
    expect(await store.get("anthropic")).toBeUndefined();
    expect(log).toHaveLength(0);
  });

  test("set emits secret.write with op=create then op=update", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    const log = collectEvents(store.events);
    await store.set("anthropic", oauthEntry);
    await store.set("anthropic", {
      ...oauthEntry,
      credentials: { ...oauthEntry.credentials, access: "acc-2" },
    });
    expect(log).toEqual([
      ["secret.write", { provider: "anthropic", kind: "oauth", op: "create" }],
      ["secret.write", { provider: "anthropic", kind: "oauth", op: "update" }],
    ]);
  });

  test("get emits secret.read", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("anthropic", oauthEntry);
    const log = collectEvents(store.events);
    await store.get("anthropic");
    expect(log).toEqual([["secret.read", { provider: "anthropic", kind: "oauth" }]]);
  });

  test("refresh on OAuth entry preserves addedAt and bumps refreshedAt", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("anthropic", { ...oauthEntry, addedAt: FIXED_NOW - 10_000 });
    const log = collectEvents(store.events);
    const newCreds = { access: "acc-2", refresh: "ref-2", expires: FIXED_NOW + 7200_000 };
    await store.refresh("anthropic", newCreds);
    const entry = await store.get("anthropic");
    expect(entry?.kind).toBe("oauth");
    if (entry?.kind === "oauth") {
      expect(entry.credentials).toEqual(newCreds);
      expect(entry.addedAt).toBe(FIXED_NOW - 10_000); // preserved
      expect(entry.refreshedAt).toBe(FIXED_NOW); // updated to now()
    }
    // refresh emits secret.refresh; the followup get above emits secret.read
    expect(log[0]).toEqual(["secret.refresh", { provider: "anthropic" }]);
  });

  test("refresh on missing provider rejects", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await expect(
      store.refresh("anthropic", { access: "x", refresh: "y", expires: 0 }),
    ).rejects.toThrow(/cannot refresh missing/);
  });

  test("refresh on apiKey-kind provider rejects", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("openai", apiKeyEntry);
    await expect(
      store.refresh("openai", { access: "x", refresh: "y", expires: 0 }),
    ).rejects.toThrow(/non-oauth/);
  });

  test("remove deletes entry and emits secret.remove", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("anthropic", oauthEntry);
    const log = collectEvents(store.events);
    await store.remove("anthropic");
    expect(await store.get("anthropic")).toBeUndefined();
    expect(log).toEqual([["secret.remove", { provider: "anthropic" }]]);
  });

  test("remove on missing provider is a no-op (no event)", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    const log = collectEvents(store.events);
    await store.remove("anthropic");
    expect(log).toHaveLength(0);
  });

  test("list returns providers sorted by name with status", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("openai", apiKeyEntry);
    await store.set("anthropic", oauthEntry);
    const list = store.list();
    expect(list.map((p) => p.provider)).toEqual(["anthropic", "openai"]);
    expect(list[0]?.kind).toBe("oauth");
    expect(list[0]?.status).toBe("ok");
    expect(list[1]?.kind).toBe("apiKey");
    expect(list[1]?.status).toBe("ok");
  });

  test("list status is 'expired' for OAuth past its expires timestamp", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("anthropic", {
      ...oauthEntry,
      credentials: { ...oauthEntry.credentials, expires: FIXED_NOW - 1 },
    });
    expect(store.getStatus("anthropic")).toBe("expired");
  });

  test("getStatus returns 'missing' for unknown providers", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    expect(store.getStatus("anthropic")).toBe("missing");
  });

  test("snapshot returns the canonical disk shape", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    await store.set("anthropic", oauthEntry);
    const snap = store.snapshot();
    expect(snap.version).toBe(SECRETS_FILE_VERSION);
    expect(snap.secrets.anthropic).toEqual(oauthEntry);
  });

  test("initial map is loaded from the SecretsFile passed in", async () => {
    const store = createSecretsStore(
      {
        version: SECRETS_FILE_VERSION,
        secrets: { anthropic: oauthEntry, openai: apiKeyEntry },
      },
      undefined,
      now,
    );
    expect(await store.get("anthropic")).toEqual(oauthEntry);
    expect(await store.get("openai")).toEqual(apiKeyEntry);
  });

  // ─── audit-first ordering (4.2-A1): emit precedes the side effect ─────────
  // A throwing audit listener must fail the originating verb AND leave the
  // store unmutated — proving the emit happens BEFORE map.set/delete+flush.

  describe("audit-first ordering: a throwing listener blocks the side effect", () => {
    const boom = () => {
      throw new Error("audit persist failed");
    };

    test("set rejects and does not commit when secret.write listener throws", async () => {
      const store = createSecretsStore(EMPTY, undefined, now);
      store.events.on("secret.write", boom);
      await expect(store.set("anthropic", oauthEntry)).rejects.toThrow(/audit persist failed/);
      // Side effect NOT committed: nothing in the snapshot.
      expect(store.snapshot().secrets).toEqual({});
    });

    test("refresh rejects and does not commit when secret.refresh listener throws", async () => {
      const store = createSecretsStore(EMPTY, undefined, now);
      await store.set("anthropic", { ...oauthEntry, addedAt: FIXED_NOW - 10_000 });
      store.events.on("secret.refresh", boom);
      const newCreds = { access: "acc-2", refresh: "ref-2", expires: FIXED_NOW + 7200_000 };
      await expect(store.refresh("anthropic", newCreds)).rejects.toThrow(/audit persist failed/);
      // Credentials unchanged — the refresh did not commit.
      const snap = store.snapshot().secrets.anthropic;
      expect(snap?.kind).toBe("oauth");
      if (snap?.kind === "oauth") {
        expect(snap.credentials.access).toBe(oauthEntry.credentials.access);
      }
    });

    test("remove rejects and does not commit when secret.remove listener throws", async () => {
      const store = createSecretsStore(EMPTY, undefined, now);
      await store.set("anthropic", oauthEntry);
      store.events.on("secret.remove", boom);
      await expect(store.remove("anthropic")).rejects.toThrow(/audit persist failed/);
      // Entry still present — the delete did not commit.
      expect(store.snapshot().secrets.anthropic).toEqual(oauthEntry);
    });
  });
});
