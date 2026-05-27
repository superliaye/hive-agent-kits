// Hive-specific Persistence adapter for the theming module.
//
// The theming module is intentionally storage-agnostic — this file is
// the one place that knows Hive talks HTTP to a local daemon.
//
// Composed of two pieces:
//   - An inner `Persistence` calling /api/appearance via the api client.
//   - A localStorage cache wrapper (from the portable theming module)
//     that lets `main.tsx` mount with a synchronous bootstrap so first
//     paint never flashes.
//
// The caching strategy used to live inline here. Pulled into a portable
// decorator (createCachingPersistence) so a future Hive build target
// (Tauri, browser-only, mobile shell) can swap the storage adapter
// without rediscovering the dance.

import { type ApiConfig, api } from "./api.ts";
import { type CacheStorage, type CachingPersistence, createCachingPersistence } from "./theming/index.ts";
import type { Persistence } from "./theming/index.ts";

const CACHE_KEY = "hive.appearance.preferences.v2";

const localStorageCache: CacheStorage = {
  read() {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(CACHE_KEY);
    } catch {
      return null;
    }
  },
  write(value) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CACHE_KEY, value);
    } catch {
      // Quota / disabled storage / private mode — non-fatal.
    }
  },
};

/**
 * Build a Persistence adapter that calls the daemon's /api/appearance
 * endpoints, wrapped with the portable localStorage paint-cache.
 */
export function createHivePersistence(cfg: ApiConfig): CachingPersistence {
  const inner: Persistence = {
    load: () => api.getAppearance(cfg),
    save: async (prefs) => {
      await api.putAppearance(cfg, prefs);
    },
  };
  return createCachingPersistence(inner, localStorageCache);
}
