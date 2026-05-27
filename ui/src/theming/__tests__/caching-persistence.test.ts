import { describe, expect, test } from "bun:test";
import { type CacheStorage, createCachingPersistence } from "../caching-persistence.ts";
import type { Persistence, Preferences } from "../types.ts";

const DEFAULTS: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
};

function memStorage(): CacheStorage & { peek(): string | null } {
  let store: string | null = null;
  return {
    read: () => store,
    write: (v) => {
      store = v;
    },
    peek: () => store,
  };
}

function memPersistence(initial: Preferences | null = null): Persistence & { saved: Preferences[] } {
  const saved: Preferences[] = [];
  return {
    saved,
    async load() {
      return initial;
    },
    async save(prefs) {
      saved.push(prefs);
    },
  };
}

describe("createCachingPersistence", () => {
  test("getCached returns null on empty storage", () => {
    const p = createCachingPersistence(memPersistence(), memStorage());
    expect(p.getCached()).toBeNull();
  });

  test("load() writes to cache for synchronous re-read", async () => {
    const storage = memStorage();
    const loaded: Preferences = { ...DEFAULTS, mode: "dark" };
    const p = createCachingPersistence(memPersistence(loaded), storage);
    await p.load();
    expect(p.getCached()).toEqual(loaded);
  });

  test("save() writes to cache before delegating to inner", async () => {
    const storage = memStorage();
    const inner = memPersistence();
    const p = createCachingPersistence(inner, storage);
    await p.save({ ...DEFAULTS, mode: "dark" });
    expect(p.getCached()?.mode).toBe("dark");
    expect(inner.saved[0]?.mode).toBe("dark");
  });

  test("malformed cache returns null (does not throw)", () => {
    const storage = memStorage();
    storage.write("not json {{{");
    const p = createCachingPersistence(memPersistence(), storage);
    expect(p.getCached()).toBeNull();
  });

  test("cache with missing mode returns null (shape guard)", () => {
    const storage = memStorage();
    storage.write(JSON.stringify({ light: {}, dark: {} }));
    const p = createCachingPersistence(memPersistence(), storage);
    expect(p.getCached()).toBeNull();
  });

  test("storage.write throw is swallowed (quota etc are non-fatal)", async () => {
    const throwingStorage: CacheStorage = {
      read: () => null,
      write: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const p = createCachingPersistence(memPersistence(), throwingStorage);
    // Must not throw — save still succeeds on the inner adapter.
    await p.save({ ...DEFAULTS, mode: "dark" });
  });

  test("inner load() failure propagates (caller decides retry)", async () => {
    const p = createCachingPersistence(
      {
        load: async () => {
          throw new Error("network down");
        },
        save: async () => undefined,
      },
      memStorage(),
    );
    await expect(p.load()).rejects.toThrow("network down");
  });
});
