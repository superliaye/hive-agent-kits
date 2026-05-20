// Hive-specific Persistence adapter for the theming module.
//
// The theming module is intentionally storage-agnostic — this file is
// the one place that knows Hive uses /api/appearance.
//
// Bootstrap strategy: cache the last-known preferences in localStorage
// so first paint applies the user's chosen theme synchronously, before
// the HTTP load completes. HTTP is the source of truth; localStorage
// is just paint-cache.

import { type ApiConfig, api } from "./api.ts";
import type { Persistence, Preferences } from "./theming/index.ts";

const CACHE_KEY = "hive.appearance.preferences.v2";

/** Synchronous read of the localStorage paint-cache. Returns undefined when absent. */
export function readBootstrap(): Preferences | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const p = parsed as Record<string, unknown>;
    if (p.mode !== "light" && p.mode !== "dark" && p.mode !== "system") return undefined;
    return parsed as Preferences;
  } catch {
    return undefined;
  }
}

function writeBootstrap(prefs: Preferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota / disabled storage — non-fatal; HTTP load still works.
  }
}

/**
 * Build a Persistence adapter that calls the daemon's /api/appearance
 * endpoints + maintains a localStorage paint-cache.
 */
export function createHivePersistence(cfg: ApiConfig): Persistence {
  return {
    async load() {
      const prefs = await api.getAppearance(cfg);
      writeBootstrap(prefs);
      return prefs;
    },
    async save(prefs) {
      writeBootstrap(prefs);
      await api.putAppearance(cfg, prefs);
    },
  };
}
