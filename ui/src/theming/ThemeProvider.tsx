// ThemeProvider — applies tokens to `:root` and exposes the active state
// via context. No styled-component framework involved: CSS variables are
// the only mechanism, and the rest of the app reads them via `var(--…)`.
//
// Rendering model: the resolved TokenMap is applied imperatively in an
// effect via `style.setProperty`. That keeps theme switches fast (no
// React re-render of styled subtrees) and side-effect-isolated.

import {
  type ReactNode,
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BUILT_IN_PRESETS, defaultPresetForMode, findPresetById } from "./presets.ts";
import { importPreferences as deserialize, exportPreferences as serialize } from "./serialize.ts";
import { getSystemMode, watchSystemMode } from "./system.ts";
import type { Persistence, Preferences, ResolvedTheme, Theme, TokenMap } from "./types.ts";

const SYSTEM_ID = "system";

export type ThemeContextValue = {
  /** Resolved active theme — preset + applied tokens. */
  resolved: ResolvedTheme;
  /** User-facing preferences (presetId, overrides, fonts). */
  preferences: Preferences;
  /** All available presets (built-ins + caller extras). */
  presets: readonly Theme[];
  /** Update preferences. Persists asynchronously; UI updates immediately. */
  setPreferences: (next: Preferences) => Promise<void>;
  /** Export current preferences as a JSON string (caller triggers download). */
  exportPreferences: () => string;
  /** Import a JSON string. Returns `{ok}` on success; on success, persists. */
  importPreferences: (
    json: string,
  ) => Promise<{ ok: true; preferences: Preferences } | { ok: false; error: string }>;
  /** True once initial persisted state has been loaded. */
  ready: boolean;
  /** Last save error, if any (network failure, etc.). */
  saveError: string | null;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = {
  /** Caller-supplied persistence adapter. Module never imports storage. */
  persistence: Persistence;
  /** Additional presets to expose alongside BUILT_IN_PRESETS. */
  extraPresets?: readonly Theme[];
  /**
   * Preferences to use until persistence resolves on first paint. The
   * caller can pass a `localStorage`-cached value here for instant
   * paint with no flash. When omitted, system-follow defaults are used.
   */
  bootstrap?: Preferences;
  children: ReactNode;
};

const DEFAULT_BOOTSTRAP: Preferences = { presetId: SYSTEM_ID };

export function ThemeProvider({
  persistence,
  extraPresets,
  bootstrap,
  children,
}: ThemeProviderProps): JSX.Element {
  const presets = useMemo<readonly Theme[]>(
    () => [...BUILT_IN_PRESETS, ...(extraPresets ?? [])],
    [extraPresets],
  );
  const [preferences, setPreferencesState] = useState<Preferences>(bootstrap ?? DEFAULT_BOOTSTRAP);
  const [systemMode, setSystemMode] = useState<"light" | "dark">(getSystemMode);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load persisted prefs on mount. If load fails we keep bootstrap state
  // and surface no error — the user can still pick a theme manually; the
  // failure to load is a startup detail, not a user-facing error.
  useEffect(() => {
    let cancelled = false;
    void persistence
      .load()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) setPreferencesState(loaded);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [persistence]);

  // Watch OS preference changes; only material when presetId === "system".
  useEffect(() => {
    return watchSystemMode((m) => setSystemMode(m));
  }, []);

  // Resolve active preset + apply overrides + fonts → TokenMap.
  const resolved = useMemo<ResolvedTheme>(() => {
    const fromSystem = preferences.presetId === SYSTEM_ID;
    const basePreset = fromSystem
      ? defaultPresetForMode(presets, systemMode)
      : (findPresetById(presets, preferences.presetId) ?? defaultPresetForMode(presets, "light"));

    const tokens: TokenMap = { ...basePreset.tokens };
    if (preferences.overrides?.background)
      tokens["color-bg-base"] = preferences.overrides.background;
    if (preferences.overrides?.foreground)
      tokens["color-fg-default"] = preferences.overrides.foreground;
    if (preferences.overrides?.accent) tokens["color-accent"] = preferences.overrides.accent;
    if (preferences.fonts?.ui) tokens["font-ui"] = preferences.fonts.ui;
    if (preferences.fonts?.code) tokens["font-code"] = preferences.fonts.code;

    return { preset: basePreset, fromSystem, tokens };
  }, [preferences, presets, systemMode]);

  // Apply tokens to :root. Imperative; this is the whole point of the
  // CSS-variable architecture.
  //
  // Cleanup on unmount: remove every token we applied + clear the
  // `data-theme*` attributes. Harmless in hive (the provider lives at the
  // app root), but the portable charter demands a host app that toggles
  // <ThemeProvider> on/off can do so without leaking tokens to :root.
  const lastAppliedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const nextKeys = new Set<string>();
    for (const [name, value] of Object.entries(resolved.tokens)) {
      root.style.setProperty(`--${name}`, value);
      nextKeys.add(name);
    }
    // Remove tokens that were present last time but not this time.
    for (const stale of lastAppliedRef.current) {
      if (!nextKeys.has(stale)) root.style.removeProperty(`--${stale}`);
    }
    lastAppliedRef.current = nextKeys;
    // `data-theme` is a convenience hook for stylesheets that want to
    // branch on mode (`[data-theme="dark"] { ... }`).
    root.setAttribute("data-theme", resolved.preset.mode);
    root.setAttribute("data-theme-id", resolved.preset.id);
  }, [resolved]);

  // Unmount cleanup — separate effect with no deps so it runs only at
  // teardown. Reads the latest applied-token set from the ref, removes
  // every variable, clears the data attributes.
  useEffect(() => {
    return () => {
      if (typeof document === "undefined") return;
      const root = document.documentElement;
      for (const name of lastAppliedRef.current) {
        root.style.removeProperty(`--${name}`);
      }
      lastAppliedRef.current = new Set();
      root.removeAttribute("data-theme");
      root.removeAttribute("data-theme-id");
    };
  }, []);

  const setPreferences = useCallback(
    async (next: Preferences) => {
      setPreferencesState(next);
      setSaveError(null);
      try {
        await persistence.save(next);
      } catch (err) {
        setSaveError((err as Error).message);
      }
    },
    [persistence],
  );

  const exportPrefs = useCallback(() => serialize(preferences), [preferences]);
  const importPrefs = useCallback(
    async (json: string) => {
      const result = deserialize(json);
      if (!result.ok) return result;
      await setPreferences(result.preferences);
      return result;
    },
    [setPreferences],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      resolved,
      preferences,
      presets,
      setPreferences,
      exportPreferences: exportPrefs,
      importPreferences: importPrefs,
      ready,
      saveError,
    }),
    [resolved, preferences, presets, setPreferences, exportPrefs, importPrefs, ready, saveError],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
