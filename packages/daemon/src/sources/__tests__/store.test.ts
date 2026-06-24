import { describe, expect, test } from "bun:test";
import { createSourcesStore, type SourcesWriter } from "../store.ts";
import { normalizeOrigin, SOURCES_FILE_VERSION } from "../types.ts";

describe("normalizeOrigin", () => {
  test("collapses .git, trailing slashes, and host case to one origin", () => {
    const canonical = normalizeOrigin("https://github.com/a/b");
    expect(normalizeOrigin("https://github.com/a/b/")).toBe(canonical);
    expect(normalizeOrigin("https://github.com/a/b//")).toBe(canonical);
    expect(normalizeOrigin("https://github.com/a/b.git")).toBe(canonical);
    expect(normalizeOrigin("https://github.com/a/b.git/")).toBe(canonical);
    expect(normalizeOrigin("https://GitHub.com/a/b")).toBe(canonical);
    expect(normalizeOrigin("HTTPS://github.com/a/b")).toBe(canonical);
  });

  test("preserves path case (significant on some forges)", () => {
    expect(normalizeOrigin("https://github.com/A/B")).not.toBe(
      normalizeOrigin("https://github.com/a/b"),
    );
  });

  test("does not throw on a non-URL string", () => {
    expect(() => normalizeOrigin("not a url")).not.toThrow();
  });
});

describe("createSourcesStore — duplicate detection over normalization", () => {
  test("rejects a .git / trailing-slash / case variant of an existing origin", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, sources: [] });
    expect(store.add("https://github.com/a/b").ok).toBe(true);
    expect(store.add("https://github.com/a/b.git")).toEqual({ ok: false, reason: "duplicate" });
    expect(store.add("https://GitHub.com/a/b/")).toEqual({ ok: false, reason: "duplicate" });
    expect(store.list()).toHaveLength(1);
  });
});

describe("createSourcesStore — write-fault atomicity", () => {
  // A persist that throws must leave the in-memory state unchanged (memory and
  // disk stay consistent), not mutate memory and diverge from disk.
  const throwingWriter: SourcesWriter = {
    write() {
      throw new Error("EACCES");
    },
  };

  test("a failed add does not append to the in-memory list", () => {
    const store = createSourcesStore(
      { version: SOURCES_FILE_VERSION, sources: [] },
      throwingWriter,
    );
    expect(() => store.add("https://github.com/a/b")).toThrow();
    expect(store.list()).toHaveLength(0);
  });

  test("a failed delete does not remove from the in-memory list", () => {
    const created = createSourcesStore({ version: SOURCES_FILE_VERSION, sources: [] }).add(
      "https://github.com/a/b",
    );
    if (!created.ok) throw new Error("setup failed");
    const failing = createSourcesStore(
      { version: SOURCES_FILE_VERSION, sources: [created.source] },
      throwingWriter,
    );
    expect(() => failing.delete(created.source.id)).toThrow();
    expect(failing.list()).toHaveLength(1);
  });
});
