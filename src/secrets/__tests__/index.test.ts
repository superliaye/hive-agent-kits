import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecrets } from "../index.ts";
import { SECRETS_FILE_VERSION, type SecretsFile } from "../types.ts";

const FUTURE_EXPIRES = 9_000_000_000_000;

describe("createSecrets — memory mode", () => {
  test("getAuth on missing provider returns undefined", () => {
    const s = createSecrets({ mode: "memory" });
    expect(s.getAuth("anthropic")).toBeUndefined();
  });

  test("setApiKey then getAuth returns AuthInput with kind=apiKey", () => {
    const s = createSecrets({ mode: "memory" });
    s.setApiKey("openai", "sk-test");
    const auth = s.getAuth("openai");
    expect(auth?.kind).toBe("apiKey");
    if (auth?.kind === "apiKey") {
      expect(auth.apiKey).toBe("sk-test");
    }
  });

  test("setApiKey replaces an existing OAuth entry for the same provider", () => {
    const s = createSecrets({
      mode: "memory",
      initial: {
        version: SECRETS_FILE_VERSION,
        secrets: {
          anthropic: {
            kind: "oauth",
            credentials: { access: "a", refresh: "r", expires: FUTURE_EXPIRES },
            addedAt: 0,
          },
        },
      },
    });
    s.setApiKey("anthropic", "sk-new");
    expect(s.getAuth("anthropic")?.kind).toBe("apiKey");
  });

  test("OAuth-seeded store: getAuth returns AuthInput with kind=oauth and bound onRefresh", async () => {
    const initial: SecretsFile = {
      version: SECRETS_FILE_VERSION,
      secrets: {
        anthropic: {
          kind: "oauth",
          credentials: { access: "acc-1", refresh: "ref-1", expires: FUTURE_EXPIRES },
          addedAt: 1_000,
        },
      },
    };
    const s = createSecrets({ mode: "memory", initial });
    const auth = s.getAuth("anthropic");
    expect(auth?.kind).toBe("oauth");
    if (auth?.kind !== "oauth") return;
    expect(auth.credentials).toEqual({
      access: "acc-1",
      refresh: "ref-1",
      expires: FUTURE_EXPIRES,
    });

    // Drive the bound onRefresh; it should mutate the underlying store.
    await auth.onRefresh({ access: "acc-2", refresh: "ref-2", expires: FUTURE_EXPIRES + 1 });

    // After refresh, a fresh getAuth reflects the new credentials.
    const next = s.getAuth("anthropic");
    expect(next?.kind).toBe("oauth");
    if (next?.kind === "oauth") {
      expect(next.credentials.access).toBe("acc-2");
      expect(next.credentials.refresh).toBe("ref-2");
    }
  });

  test("status() reports configured providers", () => {
    const s = createSecrets({ mode: "memory" });
    s.setApiKey("openai", "sk");
    expect(s.status("openai")).toBe("ok");
    expect(s.status("anthropic")).toBe("missing");
  });

  test("remove clears the entry", () => {
    const s = createSecrets({ mode: "memory" });
    s.setApiKey("openai", "sk");
    s.remove("openai");
    expect(s.getAuth("openai")).toBeUndefined();
    expect(s.status("openai")).toBe("missing");
  });

  test("list returns alphabetized configured providers", () => {
    const s = createSecrets({ mode: "memory" });
    s.setApiKey("openai", "sk");
    s.setApiKey("anthropic", "sk-ant");
    expect(s.list().map((p) => p.provider)).toEqual(["anthropic", "openai"]);
  });

  test("startOAuthLogin throws on unknown provider", async () => {
    const s = createSecrets({ mode: "memory" });
    await expect(
      s.startOAuthLogin("not-a-real-provider-zzz", {
        onAuth: () => {},
        onPrompt: async () => "",
      }),
    ).rejects.toThrow(/unknown OAuth provider/);
  });
});

describe("createSecrets — file mode", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-secrets-index-test-"));
    path = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("file mode persists writes across new instances", () => {
    const a = createSecrets({ mode: "file", path });
    a.setApiKey("openai", "sk-persist");

    const b = createSecrets({ mode: "file", path });
    const auth = b.getAuth("openai");
    expect(auth?.kind).toBe("apiKey");
    if (auth?.kind === "apiKey") {
      expect(auth.apiKey).toBe("sk-persist");
    }
  });

  test("OAuth onRefresh writes through to disk", async () => {
    const a = createSecrets({ mode: "file", path });
    // Seed an OAuth entry by reaching through the file directly is heavy;
    // instead seed via memory-mode-shaped initial via the underlying file.
    // Cleanest: write the file ourselves, then load via createSecrets.
    const initialFile: SecretsFile = {
      version: SECRETS_FILE_VERSION,
      secrets: {
        anthropic: {
          kind: "oauth",
          credentials: { access: "acc-1", refresh: "ref-1", expires: FUTURE_EXPIRES },
          addedAt: 1_000,
        },
      },
    };
    // First instance: write the seed via setApiKey then overwrite by direct write
    // through the persistence layer.
    a.remove("openai"); // ensure file exists
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(initialFile), "utf8");

    const b = createSecrets({ mode: "file", path });
    const auth = b.getAuth("anthropic");
    expect(auth?.kind).toBe("oauth");
    if (auth?.kind !== "oauth") return;

    await auth.onRefresh({ access: "acc-2", refresh: "ref-2", expires: FUTURE_EXPIRES + 1 });

    // Reload from disk; refreshed credentials should be present.
    const c = createSecrets({ mode: "file", path });
    const reloaded = c.getAuth("anthropic");
    if (reloaded?.kind === "oauth") {
      expect(reloaded.credentials.access).toBe("acc-2");
    } else {
      throw new Error("expected reloaded entry to be oauth");
    }
  });
});
