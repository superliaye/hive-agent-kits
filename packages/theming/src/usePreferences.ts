// React adapter over PreferencesController. ~10 lines of glue —
// useSyncExternalStore is the canonical way to subscribe a component
// to a non-React store with the right concurrent-mode semantics.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createPreferencesController } from "./preferences.ts";
import type { Persistence, Preferences } from "./types.ts";

export type UsePreferencesReturn = {
  preferences: Preferences;
  setPreferences: (next: Preferences) => Promise<void>;
  ready: boolean;
  saveError: string | null;
};

export function usePreferences(
  persistence: Persistence,
  bootstrap: Preferences,
): UsePreferencesReturn {
  // Recreate the controller only when persistence identity changes.
  // Callers in main.tsx pass a memoized persistence, so this is stable
  // for the lifetime of the app.
  // bootstrap intentionally NOT in deps — it's an initial value only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap is initial-only
  const controller = useMemo(
    () => createPreferencesController(persistence, bootstrap),
    [persistence],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    preferences: snapshot.preferences,
    setPreferences: controller.set,
    ready: snapshot.ready,
    saveError: snapshot.saveError,
  };
}
