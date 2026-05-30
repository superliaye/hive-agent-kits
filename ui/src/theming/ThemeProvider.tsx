// ThemeProvider — the React glue around the theming module.
//
// State management (load, optimistic apply, rollback on save failure)
// lives in `usePreferences` / `createPreferencesController` — fully
// testable without React. Theming math (mode resolution, palette
// layering, contrast modulation) lives in `resolve.ts` — pure
// functions. This component does two things only:
//
//   1. Wire the controller's snapshot into a React Context.
//   2. Apply the resolved TokenMap to `:root` via setProperty.
//
// Everything else is delegated.

import { type ReactNode, createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveMode, resolveReduceMotion, resolveTokens } from "./resolve.ts";
import { importPreferences as deserialize, exportPreferences as serialize } from "./serialize.ts";
import { getSystemMode, watchSystemMode } from "./system.ts";
import type { Persistence, Preferences, ResolvedMode, ResolvedTheme, ThemeConfig } from "./types.ts";
import { usePreferences } from "./usePreferences.ts";

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
  /** External accent applied when `prefs.useSystemAccent` is true and this is
   * non-null (e.g. the OS accent). Host-injected so the module stays portable —
   * it never knows the value came from the OS. */
  systemAccent?: string | null;
  children: ReactNode;
};

const DEFAULT_BOOTSTRAP: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
  useSystemAccent: false,
};

export function ThemeProvider({
  persistence,
  bootstrap,
  systemAccent,
  children,
}: ThemeProviderProps): JSX.Element {
  const { preferences, setPreferences, ready, saveError } = usePreferences(
    persistence,
    bootstrap ?? DEFAULT_BOOTSTRAP,
  );
  const [systemMode, setSystemMode] = useState<ResolvedMode>(getSystemMode);

  useEffect(() => watchSystemMode((m) => setSystemMode(m)), []);

  const resolved = useMemo<ResolvedTheme>(() => {
    const resolvedMode = resolveMode(preferences, systemMode);
    const baseConfig = resolvedMode === "dark" ? preferences.dark : preferences.light;
    // Effective accent: the OS accent wins when the user opted in and it's
    // available. Reuses resolveTokens' existing config.accent override path —
    // no change to resolveTokens itself.
    const config: ThemeConfig =
      preferences.useSystemAccent && systemAccent
        ? { ...baseConfig, accent: systemAccent }
        : baseConfig;
    return {
      resolvedMode,
      fromSystem: preferences.mode === "system",
      config,
      tokens: resolveTokens(config, resolvedMode),
    };
  }, [preferences, systemMode, systemAccent]);

  // Apply resolved tokens to :root imperatively — the whole point of
  // the CSS-variable architecture. Track applied keys so unmount + theme
  // switches can strip stale `--*` properties cleanly.
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
    root.setAttribute(
      "data-reduce-motion",
      resolveReduceMotion(preferences, prefersReducedMotion()),
    );
    root.setAttribute("data-pointer-cursors", preferences.pointerCursors ? "on" : "off");
  }, [resolved, preferences]);

  // Unmount cleanup — portable charter demands a host app can toggle
  // <ThemeProvider> on/off without leaking tokens to :root.
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
