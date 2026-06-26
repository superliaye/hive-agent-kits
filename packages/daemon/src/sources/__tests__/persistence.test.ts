import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourcesPersistence } from "../persistence.ts";
import { SOURCES_FILE_VERSION, type SourcesFile } from "../types.ts";

const SAMPLE: SourcesFile = {
  version: SOURCES_FILE_VERSION,
  sources: [
    {
      id: "id-1",
      origin: "https://github.com/a/b",
      kind: "git",
      active: true,
      createdAt: 1_730_000_000_000,
      rank: 1,
    },
    {
      id: "starter",
      origin: "local:starter",
      kind: "local",
      active: false,
      createdAt: 1_730_000_000_001,
      rank: 0,
    },
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

  test("round-trips a kind:'local' Source at the bumped version", () => {
    const p = new SourcesPersistence(path);
    p.write(SAMPLE);
    const back = p.read();
    expect(back).toEqual(SAMPLE);
    expect(back.sources.find((s) => s.id === "starter")?.kind).toBe("local");
  });

  test("an out-of-version (stale) file is DISCARDED → read returns EMPTY, no throw", () => {
    // A prior-schema v1 file: the version peek discards it (re-seed), rather than
    // throwing — greenfield, no migration.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sources: [{ id: "old", origin: "https://github.com/a/b", active: true, createdAt: 1 }],
      }),
      "utf8",
    );
    const p = new SourcesPersistence(path);
    expect(() => p.read()).not.toThrow();
    expect(p.read()).toEqual({ version: SOURCES_FILE_VERSION, sources: [] });
  });

  test("a SAME-version file with a bad shape still THROWS (corruption not swallowed)", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: SOURCES_FILE_VERSION, sources: [{ id: 42 }] }),
      "utf8",
    );
    const p = new SourcesPersistence(path);
    expect(() => p.read()).toThrow();
  });

  test("a file with a non-numeric/absent version is DISCARDED → EMPTY, no throw", () => {
    writeFileSync(path, JSON.stringify({ sources: [] }), "utf8");
    const p = new SourcesPersistence(path);
    expect(p.read()).toEqual({ version: SOURCES_FILE_VERSION, sources: [] });
  });

  test("isCurrentVersion: absent → false; stale-version → false; current (even empty) → true", () => {
    const p = new SourcesPersistence(path);
    expect(p.isCurrentVersion()).toBe(false); // absent

    writeFileSync(path, JSON.stringify({ version: 1, sources: [] }), "utf8");
    expect(p.isCurrentVersion()).toBe(false); // stale

    writeFileSync(path, JSON.stringify({ version: SOURCES_FILE_VERSION, sources: [] }), "utf8");
    expect(p.isCurrentVersion()).toBe(true); // current, even empty (delete-no-reseed)
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
