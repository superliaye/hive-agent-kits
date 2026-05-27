// Caching wrapper around a Persistence adapter. The portable module
// itself can't depend on localStorage / SessionStorage / IndexedDB,
// but the no-flash-on-first-paint pattern is repeatable: read a cached
// snapshot synchronously at app start, mount with that as `bootstrap`,
// then let the inner `load()` resolve asynchronously and overwrite.
//
// Shipped as a decorator over `Persistence` rather than a feature of
// the base interface so the simple case (in-memory test fakes, server-
// rendered apps) doesn't have to opt out. Two-is-coincidence today
// (hive uses it once, future apps would be the second adapter) but the
// pattern collapses to a one-line wrap when adopted.

import type { Persistence, Preferences } from "./types.ts";

/** Minimal storage interface — adapters provide read/write of a string blob.
 * localStorage, sessionStorage, an Electron config file, anything. */
export type CacheStorage = {
  read(): string | null;
  write(value: string): void;
};

export type CachingPersistence = Persistence & {
  /** Synchronous read of the last-cached preferences. Returns `null`
   * when the cache is empty or unreadable. Use as the `bootstrap` prop
   * on ThemeProvider for no-flash first paint. */
  getCached(): Preferences | null;
};

export function createCachingPersistence(
  inner: Persistence,
  storage: CacheStorage,
): CachingPersistence {
  function readCache(): Preferences | null {
    let raw: string | null;
    try {
      raw = storage.read();
    } catch {
      return null;
    }
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    // Minimal shape check — full validation is the inner adapter's job
    // when load() resolves. The cache is a paint optimization, not a
    // source of truth; a malformed entry just means no-cache + load.
    const p = parsed as Record<string, unknown>;
    if (p.mode !== "light" && p.mode !== "dark" && p.mode !== "system") return null;
    return parsed as Preferences;
  }

  function writeCache(prefs: Preferences): void {
    try {
      storage.write(JSON.stringify(prefs));
    } catch {
      // Quota exceeded, disabled storage, etc. Non-fatal — load() still
      // works without a cache, the user just gets a paint flash next time.
    }
  }

  return {
    async load() {
      const fresh = await inner.load();
      if (fresh) writeCache(fresh);
      return fresh;
    },
    async save(prefs) {
      writeCache(prefs);
      await inner.save(prefs);
    },
    getCached: readCache,
  };
}
