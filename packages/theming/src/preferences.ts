// Preferences controller — plain-JS state machine for the Appearance
// flow. Owns the optimistic-apply + rollback dance, async persistence
// load, and the lastSaved snapshot that rollback targets. No React.
//
// Why a controller, not a hook: the interesting logic is async state
// management, not rendering. Extracting it from the React component
// makes it testable in isolation (no DOM, no useEffect ordering, no
// strict-mode double-invoke gotchas) and gives a single deletion-test
// answer: deleting this concentrates the state machine in one place.
// `usePreferences` is the thin React adapter on top.

import type { Persistence, Preferences } from "./types.ts";

export type PreferencesSnapshot = {
  preferences: Preferences;
  ready: boolean;
  saveError: string | null;
};

export type PreferencesController = {
  /** Stable-reference snapshot suitable for `useSyncExternalStore`. */
  getSnapshot(): PreferencesSnapshot;
  /** Optimistic apply + persist; rolls back to last-accepted on reject. */
  set(next: Preferences): Promise<void>;
  /** Subscribe to snapshot changes; returns a disposer. */
  subscribe(listener: () => void): () => void;
  /** Stop accepting load completions + clear listeners. */
  dispose(): void;
};

export function createPreferencesController(
  persistence: Persistence,
  bootstrap: Preferences,
): PreferencesController {
  let current: Preferences = bootstrap;
  // Last value the daemon successfully accepted. Rollback target.
  // Closing over React state at callback creation captures a stale
  // snapshot under rapid edits; a ref-style cell on the controller
  // is the canonical answer.
  let lastSaved: Preferences = bootstrap;
  let ready = false;
  let saveError: string | null = null;
  let snapshot: PreferencesSnapshot = { preferences: current, ready, saveError };
  let disposed = false;
  const listeners = new Set<() => void>();

  function refresh(): void {
    // Allocate a fresh object only when state changes — keeps
    // `getSnapshot` stable between unrelated reads (required by
    // `useSyncExternalStore` to avoid infinite re-renders).
    snapshot = { preferences: current, ready, saveError };
    for (const l of listeners) l();
  }

  void persistence
    .load()
    .then((loaded) => {
      if (disposed) return;
      if (loaded) {
        current = loaded;
        lastSaved = loaded;
      }
      ready = true;
      refresh();
    })
    .catch(() => {
      if (disposed) return;
      ready = true;
      refresh();
    });

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async set(next) {
      current = next;
      saveError = null;
      refresh();
      try {
        await persistence.save(next);
        lastSaved = next;
      } catch (err) {
        current = lastSaved;
        saveError = (err as Error).message;
        refresh();
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
