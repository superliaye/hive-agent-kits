import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretsPersistence } from "../persistence.ts";
import { SECRETS_FILE_VERSION, type SecretsFile } from "../types.ts";

const SAMPLE: SecretsFile = {
  version: SECRETS_FILE_VERSION,
  secrets: {
    anthropic: {
      kind: "oauth",
      credentials: { access: "acc-1", refresh: "ref-1", expires: 9_000_000_000_000 },
      addedAt: 1_730_000_000_000,
    },
    openai: { kind: "apiKey", apiKey: "sk-test", addedAt: 1_730_000_000_000 },
  },
};

describe("SecretsPersistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-secrets-test-"));
    path = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("read on missing file returns empty canonical shape", () => {
    const p = new SecretsPersistence(path);
    expect(p.exists()).toBe(false);
    expect(p.read()).toEqual({ version: SECRETS_FILE_VERSION, secrets: {} });
  });

  test("write then read round-trips the file", () => {
    const p = new SecretsPersistence(path);
    p.write(SAMPLE);
    expect(p.exists()).toBe(true);
    expect(p.read()).toEqual(SAMPLE);
  });

  test("write is atomic: no .tmp left on disk after success", () => {
    const p = new SecretsPersistence(path);
    p.write(SAMPLE);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("read throws on schema violation (bad shape)", () => {
    writeFileSync(path, JSON.stringify({ version: 999, secrets: {} }), "utf8");
    const p = new SecretsPersistence(path);
    expect(() => p.read()).toThrow();
  });

  test("read throws on schema violation (bad entry kind)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: SECRETS_FILE_VERSION,
        secrets: { x: { kind: "unknown", whatever: true } },
      }),
      "utf8",
    );
    const p = new SecretsPersistence(path);
    expect(() => p.read()).toThrow();
  });

  test("write creates intermediate directories", () => {
    const nested = join(dir, "deep", "nested", "secrets.json");
    const p = new SecretsPersistence(nested);
    p.write(SAMPLE);
    expect(existsSync(nested)).toBe(true);
  });

  test("remove deletes the file", () => {
    const p = new SecretsPersistence(path);
    p.write(SAMPLE);
    expect(p.exists()).toBe(true);
    p.remove();
    expect(p.exists()).toBe(false);
  });

  test("remove on missing file is a no-op", () => {
    const p = new SecretsPersistence(path);
    expect(() => p.remove()).not.toThrow();
  });

  test("written JSON is human-readable (formatted with 2-space indent)", () => {
    const p = new SecretsPersistence(path);
    p.write(SAMPLE);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('\n  "version"');
    expect(raw).toContain('\n  "secrets"');
  });
});
