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

export { ThemeProvider } from "./ThemeProvider.tsx";
export type { ThemeContextValue, ThemeProviderProps } from "./ThemeProvider.tsx";
export { useTheme } from "./useTheme.ts";
export {
  BUILT_IN_PRESETS,
  DARK_PRESET,
  DIM_PRESET,
  FONT_OPTIONS,
  HIGH_CONTRAST_PRESET,
  LIGHT_PRESET,
  defaultPresetForMode,
  findPresetById,
} from "./presets.ts";
export type {
  Persistence,
  Preferences,
  ResolvedTheme,
  Theme,
  TokenMap,
  TokenName,
} from "./types.ts";
export {
  PREFERENCES_FILE_VERSION,
  exportPreferences,
  importPreferences,
} from "./serialize.ts";
export type { ImportResult, PreferencesFile } from "./serialize.ts";
export { getSystemMode, watchSystemMode } from "./system.ts";
