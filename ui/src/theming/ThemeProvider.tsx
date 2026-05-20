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
import {
  DEFAULT_CONTRAST,
  DEFAULT_FONT_CODE_SIZE,
  DEFAULT_FONT_UI_SIZE,
  paletteFor,
} from "./presets.ts";
import { importPreferences as deserialize, exportPreferences as serialize } from "./serialize.ts";
import { getSystemMode, watchSystemMode } from "./system.ts";
import type {
  Persistence,
  Preferences,
  ResolvedMode,
  ResolvedTheme,
  ThemeConfig,
  TokenMap,
} from "./types.ts";

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

function resolveMode(prefs: Preferences, systemMode: ResolvedMode): ResolvedMode {
  if (prefs.mode === "light" || prefs.mode === "dark") return prefs.mode;
  return systemMode;
}

function buildTokens(config: ThemeConfig, mode: ResolvedMode): TokenMap {
  const palette = paletteFor(mode);
  const tokens: TokenMap = { ...palette.tokens };

  if (config.accent) {
    tokens["color-accent"] = config.accent;
  }
  if (config.background) tokens["color-bg-base"] = config.background;
  if (config.foreground) tokens["color-fg-default"] = config.foreground;
  if (config.fontUi) tokens["font-ui"] = config.fontUi;
  if (config.fontCode) tokens["font-code"] = config.fontCode;

  const uiSize = config.fontUiSize ?? DEFAULT_FONT_UI_SIZE;
  const codeSize = config.fontCodeSize ?? DEFAULT_FONT_CODE_SIZE;
  tokens["font-size-ui"] = `${uiSize}px`;
  tokens["font-size-code"] = `${codeSize}px`;

  // Contrast: blend fg-default toward bg-base. 100 = pure fg-default
  // (max contrast), 0 = pure bg-base (no contrast). Default 50 ≈ neutral.
  const contrast = config.contrast ?? DEFAULT_CONTRAST;
  const clamped = Math.max(0, Math.min(100, contrast));
  tokens["color-fg-muted"] =
    `color-mix(in srgb, ${tokens["color-fg-default"]} ${clamped}%, ${tokens["color-bg-base"]})`;

  tokens["sidebar-opacity"] = config.translucentSidebar ? "0.78" : "1";

  return tokens;
}

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
    const tokens = buildTokens(config, resolvedMode);
    return {
      resolvedMode,
      fromSystem: preferences.mode === "system",
      config,
      tokens,
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
    root.setAttribute("data-reduce-motion", reduceMotionValue(preferences, systemMode));
    root.setAttribute("data-pointer-cursors", preferences.pointerCursors ? "on" : "off");
  }, [resolved, preferences, systemMode]);

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

function reduceMotionValue(prefs: Preferences, _systemMode: ResolvedMode): "on" | "off" {
  if (prefs.reduceMotion === "on") return "on";
  if (prefs.reduceMotion === "off") return "off";
  // "system" — read prefers-reduced-motion at this moment.
  if (typeof window === "undefined" || !window.matchMedia) return "off";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "on" : "off";
}
