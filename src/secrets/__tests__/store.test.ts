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
    store.set("anthropic", oauthEntry);
    expect(store.get("anthropic")).toEqual(oauthEntry);
  });

  test("get on missing provider returns undefined and emits no event", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    const log = collectEvents(store.events);
    expect(store.get("anthropic")).toBeUndefined();
    await Promise.resolve();
    expect(log).toHaveLength(0);
  });

  test("set emits secret.write with op=create then op=update", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    const log = collectEvents(store.events);
    store.set("anthropic", oauthEntry);
    store.set("anthropic", {
      ...oauthEntry,
      credentials: { ...oauthEntry.credentials, access: "acc-2" },
    });
    await Promise.resolve();
    expect(log).toEqual([
      ["secret.write", { provider: "anthropic", kind: "oauth", op: "create" }],
      ["secret.write", { provider: "anthropic", kind: "oauth", op: "update" }],
    ]);
  });

  test("get emits secret.read", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("anthropic", oauthEntry);
    const log = collectEvents(store.events);
    store.get("anthropic");
    await Promise.resolve();
    expect(log).toEqual([["secret.read", { provider: "anthropic", kind: "oauth" }]]);
  });

  test("refresh on OAuth entry preserves addedAt and bumps refreshedAt", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("anthropic", { ...oauthEntry, addedAt: FIXED_NOW - 10_000 });
    const log = collectEvents(store.events);
    const newCreds = { access: "acc-2", refresh: "ref-2", expires: FIXED_NOW + 7200_000 };
    store.refresh("anthropic", newCreds);
    const entry = store.get("anthropic");
    expect(entry?.kind).toBe("oauth");
    if (entry?.kind === "oauth") {
      expect(entry.credentials).toEqual(newCreds);
      expect(entry.addedAt).toBe(FIXED_NOW - 10_000); // preserved
      expect(entry.refreshedAt).toBe(FIXED_NOW); // updated to now()
    }
    await Promise.resolve();
    // refresh emits secret.refresh; the followup get above emits secret.read
    expect(log[0]).toEqual(["secret.refresh", { provider: "anthropic" }]);
  });

  test("refresh on missing provider throws", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    expect(() => store.refresh("anthropic", { access: "x", refresh: "y", expires: 0 })).toThrow(
      /cannot refresh missing/,
    );
  });

  test("refresh on apiKey-kind provider throws", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("openai", apiKeyEntry);
    expect(() => store.refresh("openai", { access: "x", refresh: "y", expires: 0 })).toThrow(
      /non-oauth/,
    );
  });

  test("remove deletes entry and emits secret.remove", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("anthropic", oauthEntry);
    const log = collectEvents(store.events);
    store.remove("anthropic");
    expect(store.get("anthropic")).toBeUndefined();
    await Promise.resolve();
    expect(log).toEqual([["secret.remove", { provider: "anthropic" }]]);
  });

  test("remove on missing provider is a no-op (no event)", async () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    const log = collectEvents(store.events);
    store.remove("anthropic");
    await Promise.resolve();
    expect(log).toHaveLength(0);
  });

  test("list returns providers sorted by name with status", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("openai", apiKeyEntry);
    store.set("anthropic", oauthEntry);
    const list = store.list();
    expect(list.map((p) => p.provider)).toEqual(["anthropic", "openai"]);
    expect(list[0]?.kind).toBe("oauth");
    expect(list[0]?.status).toBe("ok");
    expect(list[1]?.kind).toBe("apiKey");
    expect(list[1]?.status).toBe("ok");
  });

  test("list status is 'expired' for OAuth past its expires timestamp", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("anthropic", {
      ...oauthEntry,
      credentials: { ...oauthEntry.credentials, expires: FIXED_NOW - 1 },
    });
    expect(store.getStatus("anthropic")).toBe("expired");
  });

  test("getStatus returns 'missing' for unknown providers", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    expect(store.getStatus("anthropic")).toBe("missing");
  });

  test("snapshot returns the canonical disk shape", () => {
    const store = createSecretsStore(EMPTY, undefined, now);
    store.set("anthropic", oauthEntry);
    const snap = store.snapshot();
    expect(snap.version).toBe(SECRETS_FILE_VERSION);
    expect(snap.secrets.anthropic).toEqual(oauthEntry);
  });

  test("initial map is loaded from the SecretsFile passed in", () => {
    const store = createSecretsStore(
      {
        version: SECRETS_FILE_VERSION,
        secrets: { anthropic: oauthEntry, openai: apiKeyEntry },
      },
      undefined,
      now,
    );
    expect(store.get("anthropic")).toEqual(oauthEntry);
    expect(store.get("openai")).toEqual(apiKeyEntry);
  });
});
