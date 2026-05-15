import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { createConfig } from "../index.ts";
import { ConfigPersistence } from "../persistence.ts";

const Schema = z.object({
  audit: z.object({
    retention: z.object({
      autoRotate: z.boolean(),
      days: z.number().int().positive(),
    }),
  }),
  ui: z.object({ theme: z.enum(["light", "dark"]) }),
});

type TestConfig = z.infer<typeof Schema>;

const DEFAULTS: TestConfig = {
  audit: { retention: { autoRotate: false, days: 90 } },
  ui: { theme: "dark" },
};

describe("ConfigPersistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-config-test-"));
    path = join(dir, "config.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("write produces valid YAML readable as the same value", () => {
    const p = new ConfigPersistence(path);
    p.write(DEFAULTS);
    expect(existsSync(path)).toBe(true);
    expect(p.read()).toEqual(DEFAULTS);
  });

  test("write is atomic — leaves no .tmp file behind", () => {
    const p = new ConfigPersistence(path);
    p.write(DEFAULTS);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("write creates parent directory if missing", () => {
    const deepPath = join(dir, "nested", "deep", "config.yaml");
    const p = new ConfigPersistence(deepPath);
    p.write(DEFAULTS);
    expect(existsSync(deepPath)).toBe(true);
  });
});

describe("Config store (file mode)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-config-test-"));
    path = join(dir, "config.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("seeds defaults to disk when file is missing", () => {
    const config = createConfig({ mode: "file", path, defaults: DEFAULTS, schema: Schema });
    expect(existsSync(path)).toBe(true);
    expect(config.get("ui").theme).toBe("dark");
    config.dispose();
  });

  test("loads existing file and overrides defaults", () => {
    writeFileSync(path, stringify({ ui: { theme: "light" } }), "utf-8");
    const config = createConfig({ mode: "file", path, defaults: DEFAULTS, schema: Schema });
    expect(config.get("ui").theme).toBe("light");
    // Missing keys filled from defaults
    expect(config.get("audit").retention.days).toBe(90);
    config.dispose();
  });

  test("set persists to disk", async () => {
    const config = createConfig({ mode: "file", path, defaults: DEFAULTS, schema: Schema });
    await config.set("ui", { theme: "light" });

    const onDisk = readFileSync(path, "utf-8");
    expect(onDisk).toContain("light");
    config.dispose();
  });

  test("external edit triggers change event with source: external", async () => {
    const config = createConfig({ mode: "file", path, defaults: DEFAULTS, schema: Schema });

    const seen: Array<{ theme: string }> = [];
    config.watch("ui", (v) => seen.push(v));
    seen.length = 0; // drop initial fire

    // Wait past the self-write suppression window from createConfig's seed.
    await Bun.sleep(300);

    // Simulate an external editor saving the file
    writeFileSync(path, stringify({ ui: { theme: "light" } }), "utf-8");

    // fs.watch latency varies by platform (Windows can be 200–500ms).
    await waitFor(() => seen.length >= 1, 2000);

    expect(seen[seen.length - 1]?.theme).toBe("light");
    expect(config.get("ui").theme).toBe("light");

    config.dispose();
  });

  test("invalid external edit is rejected; current state preserved", async () => {
    const config = createConfig({ mode: "file", path, defaults: DEFAULTS, schema: Schema });
    await Bun.sleep(300);

    writeFileSync(
      path,
      stringify({ audit: { retention: { autoRotate: "not-a-boolean", days: 90 } } }),
      "utf-8",
    );
    // Give the watcher time to fire and the rejected-edit path to run.
    await Bun.sleep(500);

    // Original value retained — invalid edits don't corrupt in-memory state
    expect(config.get("audit").retention.autoRotate).toBe(false);
    config.dispose();
  });
});

// Wait until `predicate()` returns true or `timeoutMs` elapses. Polls every
// 25 ms. Returns once satisfied; throws on timeout. Used for file-watcher
// tests where latency varies by platform.
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
    }
    await Bun.sleep(25);
  }
}
