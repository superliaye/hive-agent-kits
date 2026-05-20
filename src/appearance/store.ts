// In-memory store + event emitter for the Appearance module. Pattern
// mirrors Secrets: store holds the canonical state; persistence is
// injected; mutations flush + emit.

import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { AppearancePersistence } from "./persistence.ts";
import {
  APPEARANCE_FILE_VERSION,
  type AppearanceEvents,
  type AppearanceFile,
  type Preferences,
} from "./types.ts";

export type AppearanceStore = {
  /** Get the current preferences. Emits `appearance.read`. */
  get(): Preferences;

  /** Replace preferences. Emits `appearance.changed`. Persists. */
  set(prefs: Preferences): void;

  /** Snapshot of the canonical file shape (for tests, future migration). */
  snapshot(): AppearanceFile;

  events: TypedEmitter<AppearanceEvents>;
};

export function createAppearanceStore(
  initial: AppearanceFile,
  persist?: AppearancePersistence,
): AppearanceStore {
  let current = initial.preferences;
  const events = new TypedEmitter<AppearanceEvents>();

  function flush(): void {
    if (persist) {
      persist.write({ version: APPEARANCE_FILE_VERSION, preferences: current });
    }
  }

  return {
    events,

    get() {
      void events.emit("appearance.read", { mode: current.mode });
      return current;
    },

    set(prefs) {
      current = prefs;
      flush();
      void events.emit("appearance.changed", { mode: current.mode });
    },

    snapshot() {
      return { version: APPEARANCE_FILE_VERSION, preferences: current };
    },
  };
}
