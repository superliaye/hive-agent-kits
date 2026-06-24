import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourcesPersistence } from "../persistence.ts";
import { SOURCES_FILE_VERSION, type SourcesFile } from "../types.ts";

const SAMPLE: SourcesFile = {
  version: SOURCES_FILE_VERSION,
  sources: [
    { id: "id-1", origin: "https://github.com/a/b", active: true, createdAt: 1_730_000_000_000 },
    { id: "id-2", origin: "https://github.com/c/d", active: false, createdAt: 1_730_000_000_001 },
  ],
};

describe("SourcesPersistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-sources-test-"));
    path = join(dir, "sources.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("read on missing file returns empty canonical shape", () => {
    const p = new SourcesPersistence(path);
    expect(p.exists()).toBe(false);
    expect(p.read()).toEqual({ version: SOURCES_FILE_VERSION, sources: [] });
  });

  test("write then read round-trips the file", () => {
    const p = new SourcesPersistence(path);
    p.write(SAMPLE);
    expect(p.exists()).toBe(true);
    expect(p.read()).toEqual(SAMPLE);
  });

  test("write is atomic: no .tmp left on disk after success", () => {
    const p = new SourcesPersistence(path);
    p.write(SAMPLE);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("read throws on schema violation (bad version)", () => {
    writeFileSync(path, JSON.stringify({ version: 999, sources: [] }), "utf8");
    const p = new SourcesPersistence(path);
    expect(() => p.read()).toThrow();
  });

  test("write creates intermediate directories", () => {
    const nested = join(dir, "deep", "nested", "sources.json");
    const p = new SourcesPersistence(nested);
    p.write(SAMPLE);
    expect(existsSync(nested)).toBe(true);
  });

  test("written JSON is human-readable (2-space indent)", () => {
    const p = new SourcesPersistence(path);
    p.write(SAMPLE);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('\n  "version"');
    expect(raw).toContain('\n  "sources"');
  });
});
