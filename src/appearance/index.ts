// Public API for the Appearance module.
//
// Persists the user's theme + font preferences at `~/.hive/appearance.json`
// (mirrors Secrets' on-disk shape). The HTTP layer exposes get/put on
// `/api/appearance` — the UI's portable theming module talks to that
// endpoint through a thin hive-specific persistence adapter.

import { AppearancePersistence } from "./persistence.ts";
import { type AppearanceStore, createAppearanceStore } from "./store.ts";
import { APPEARANCE_FILE_VERSION, DEFAULT_PREFERENCES } from "./types.ts";

export type CreateAppearanceOptions = { mode: "memory" } | { mode: "file"; path: string };

export type Appearance = AppearanceStore;

export function createAppearance(opts: CreateAppearanceOptions): Appearance {
  let persist: AppearancePersistence | undefined;
  let initial: { version: typeof APPEARANCE_FILE_VERSION; preferences: typeof DEFAULT_PREFERENCES };
  if (opts.mode === "memory") {
    initial = { version: APPEARANCE_FILE_VERSION, preferences: DEFAULT_PREFERENCES };
  } else {
    persist = new AppearancePersistence(opts.path);
    initial = persist.read();
  }
  return createAppearanceStore(initial, persist);
}

export type { AppearanceEvents, AppearanceFile, Preferences } from "./types.ts";
export {
  APPEARANCE_FILE_VERSION,
  AppearanceFileSchema,
  DEFAULT_PREFERENCES,
  PreferencesSchema,
} from "./types.ts";
