// Public API for the theming Module.
//
// To use:
//   1. Import `./theming/tokens.css` (or your equivalent) once at app entry.
//   2. Build a `Persistence` adapter that satisfies the type.
//   3. Wrap your app in `<ThemeProvider persistence={...}>`.
//   4. Consume `useTheme()` in your settings UI.
//   5. Reference tokens via `var(--color-bg-base)` etc. in your CSS.
//
// Portability rule: this directory imports ONLY React + its own siblings.
// Zero coupling to any app's API client, server, or domain types.

export type { CacheStorage, CachingPersistence } from "./caching-persistence.ts";
export { createCachingPersistence } from "./caching-persistence.ts";
export type { PreferencesController, PreferencesSnapshot } from "./preferences.ts";
export { createPreferencesController } from "./preferences.ts";
export type { NamedTheme } from "./presets.ts";
export {
  DARK_PALETTE,
  DARK_THEMES,
  DEFAULT_CONTRAST,
  DEFAULT_FONT_CODE,
  DEFAULT_FONT_CODE_SIZE,
  DEFAULT_FONT_UI,
  DEFAULT_FONT_UI_SIZE,
  FONT_SUGGESTIONS,
  findNamedTheme,
  LIGHT_PALETTE,
  LIGHT_THEMES,
  namedThemesFor,
  paletteFor,
} from "./presets.ts";
export { resolveMode, resolveReduceMotion, resolveTokens } from "./resolve.ts";
export type { ImportResult, PreferencesFile } from "./serialize.ts";
export {
  exportPreferences,
  exportPreferencesWire,
  importPreferences,
  PREFERENCES_FILE_VERSION,
  THEME_WIRE_PREFIX,
} from "./serialize.ts";
export { getSystemMode, watchSystemMode } from "./system.ts";
export type { ThemeContextValue, ThemeProviderProps } from "./ThemeProvider.tsx";
export { ThemeProvider } from "./ThemeProvider.tsx";
export type {
  Mode,
  ModePalette,
  Persistence,
  Preferences,
  ReduceMotion,
  ResolvedMode,
  ResolvedTheme,
  ThemeConfig,
  TokenMap,
  TokenName,
} from "./types.ts";
export type { UsePreferencesReturn } from "./usePreferences.ts";
export { usePreferences } from "./usePreferences.ts";
export { useTheme } from "./useTheme.ts";
