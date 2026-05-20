// ThemeProvider — resolves Preferences to a TokenMap and applies it to
// `:root` as CSS variables. Also sets data-* attributes that app CSS can
// branch on (data-theme, data-reduce-motion, data-pointer-cursors).
//
// Rendering model: the resolved tokens are applied imperatively in an
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
import { resolveMode, resolveReduceMotion, resolveTokens } from "./resolve.ts";
import { importPreferences as deserialize, exportPreferences as serialize } from "./serialize.ts";
import { getSystemMode, watchSystemMode } from "./system.ts";
import type { Persistence, Preferences, ResolvedMode, ResolvedTheme } from "./types.ts";

export type ThemeContextValue = {
  resolved: ResolvedTheme;
  preferences: Preferences;
  /** Update preferences. Persists asynchronously; UI updates immediately. */
  setPreferences: (next: Preferences) => Promise<void>;
  /** Export current preferences as a string (with codex-theme-v1: prefix). */
  exportPreferences: () => string;
  /** Import a string (with or without prefix). Returns tagged result. */
  importPreferences: (
    text: string,
  ) => Promise<{ ok: true; preferences: Preferences } | { ok: false; error: string }>;
  ready: boolean;
  saveError: string | null;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = {
  persistence: Persistence;
  /** Preferences for the first paint before persistence resolves. */
  bootstrap?: Preferences;
  children: ReactNode;
};

const DEFAULT_BOOTSTRAP: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
};

// Theming math (mode resolution, palette layering, contrast modulation)
// lives in resolve.ts so it's testable + callable from any context.
// ThemeProvider here is just the React glue around it.

export function ThemeProvider({
  persistence,
  bootstrap,
  children,
}: ThemeProviderProps): JSX.Element {
  const [preferences, setPreferencesState] = useState<Preferences>(bootstrap ?? DEFAULT_BOOTSTRAP);
  const [systemMode, setSystemMode] = useState<ResolvedMode>(getSystemMode);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  useEffect(() => {
    return watchSystemMode((m) => setSystemMode(m));
  }, []);

  const resolved = useMemo<ResolvedTheme>(() => {
    const resolvedMode = resolveMode(preferences, systemMode);
    const config = resolvedMode === "dark" ? preferences.dark : preferences.light;
    return {
      resolvedMode,
      fromSystem: preferences.mode === "system",
      config,
      tokens: resolveTokens(config, resolvedMode),
    };
  }, [preferences, systemMode]);

  const lastAppliedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const nextKeys = new Set<string>();
    for (const [name, value] of Object.entries(resolved.tokens)) {
      root.style.setProperty(`--${name}`, value);
      nextKeys.add(name);
    }
    for (const stale of lastAppliedRef.current) {
      if (!nextKeys.has(stale)) root.style.removeProperty(`--${stale}`);
    }
    lastAppliedRef.current = nextKeys;
    root.setAttribute("data-theme", resolved.resolvedMode);
    root.setAttribute("data-reduce-motion", resolveReduceMotion(preferences, prefersReducedMotion()));
    root.setAttribute("data-pointer-cursors", preferences.pointerCursors ? "on" : "off");
  }, [resolved, preferences]);

  // Unmount cleanup — strip everything we put on :root.
  useEffect(() => {
    return () => {
      if (typeof document === "undefined") return;
      const root = document.documentElement;
      for (const name of lastAppliedRef.current) {
        root.style.removeProperty(`--${name}`);
      }
      lastAppliedRef.current = new Set();
      root.removeAttribute("data-theme");
      root.removeAttribute("data-reduce-motion");
      root.removeAttribute("data-pointer-cursors");
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
    async (text: string) => {
      const result = deserialize(text);
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
      setPreferences,
      exportPreferences: exportPrefs,
      importPreferences: importPrefs,
      ready,
      saveError,
    }),
    [resolved, preferences, setPreferences, exportPrefs, importPrefs, ready, saveError],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
