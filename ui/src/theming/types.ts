// Theming module — types. ZERO hive-specific imports; the module is
// portable to any React+Vite (or React+anything) app.
//
// Model:
//   - Preferences has three parts: a `mode` picker, two ThemeConfigs
//     (one per concrete mode), and a few app-wide accessibility toggles.
//   - The mode picker chooses Light / Dark / System.
//   - The matching ThemeConfig (light or dark, resolved from system at
//     runtime if needed) supplies color/font overrides on top of that
//     mode's base palette.
//
// CSS contract: tokens are applied to `:root` as `--token-name: value`.
// Stylesheets reference them via `var(--…)`. ThemeProvider also sets
// `data-theme`, `data-reduce-motion`, `data-pointer-cursors` attributes
// so app CSS can branch on coarse state without re-reading tokens.

export type TokenName =
  // Backgrounds — base → surface → elevated, increasing prominence.
  | "color-bg-base"
  | "color-bg-surface"
  | "color-bg-elevated"
  | "color-bg-hover"
  // Foregrounds.
  | "color-fg-default"
  | "color-fg-muted"
  | "color-fg-on-accent"
  // Accent (primary action) — base + hover variant.
  | "color-accent"
  | "color-accent-hover"
  // Borders.
  | "color-border-default"
  | "color-border-strong"
  // Status colors.
  | "color-danger"
  | "color-warning"
  | "color-success"
  // Fonts — stacks, not URLs. No web-font loading from this module.
  | "font-ui"
  | "font-code"
  // Font sizes (px, applied as `Xpx`).
  | "font-size-ui"
  | "font-size-code"
  // Sidebar opacity — 0..1, used by app CSS for translucent surfaces.
  | "sidebar-opacity";

export type TokenMap = Partial<Record<TokenName, string>> & Record<string, string>;

export type Mode = "light" | "dark" | "system";
export type ResolvedMode = "light" | "dark";
export type ReduceMotion = "system" | "on" | "off";

/**
 * Per-mode user-customizable settings. Everything optional — empty means
 * "use the mode's defaults". Persisted separately for light and dark so
 * the user customizes each independently (matches Codex desktop's model).
 */
export type ThemeConfig = {
  /** Named palette id (see presets.ts: LIGHT_THEMES / DARK_THEMES). */
  themeId?: string;
  accent?: string;
  background?: string;
  foreground?: string;
  fontUi?: string;
  fontCode?: string;
  /** Base UI font size in px. Default 14. */
  fontUiSize?: number;
  /** Base code font size in px. Default 13. */
  fontCodeSize?: number;
  /**
   * Contrast 0..100. 50 is neutral. Higher values darken the muted
   * foreground (more contrast). Applied via `color-mix` on `--color-fg-muted`.
   */
  contrast?: number;
  translucentSidebar?: boolean;
};

/** Default base palette for one mode. Pure data — adapters override. */
export type ModePalette = {
  mode: ResolvedMode;
  tokens: TokenMap;
};

export type Preferences = {
  mode: Mode;
  light: ThemeConfig;
  dark: ThemeConfig;
  reduceMotion: ReduceMotion;
  pointerCursors: boolean;
};

/**
 * Persistence adapter. Caller provides one; the theming module never
 * imports localStorage / fetch / electron-store directly.
 *
 * Contract:
 *   - `load()` returns `null` when no preferences are stored yet (e.g.
 *     first launch). Returns the persisted `Preferences` otherwise.
 *   - `save(prefs)` persists. Throws on persistence failure — the
 *     ThemeProvider surfaces the throw as `useTheme().saveError`.
 */
export type Persistence = {
  load(): Promise<Preferences | null>;
  save(prefs: Preferences): Promise<void>;
};

/** What `useTheme()` exposes about the currently-applied theme. */
export type ResolvedTheme = {
  resolvedMode: ResolvedMode;
  /** True when `Preferences.mode === "system"` and matchMedia picked the mode. */
  fromSystem: boolean;
  /** Effective config (the matching mode's ThemeConfig). */
  config: ThemeConfig;
  /** Final token map after defaults + overrides + derived values. */
  tokens: TokenMap;
};
