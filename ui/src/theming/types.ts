// Theming module — types. ZERO hive-specific imports; the module is
// portable to any React+Vite (or React+anything) app.
//
// Architecture, in one paragraph:
//   The application's CSS uses CSS variables (`var(--color-bg-base)` etc).
//   A preset is a flat `Record<TokenName, string>` — pure data. The
//   ThemeProvider takes a Preferences object (preset id + overrides +
//   fonts), resolves the active token map, and applies the values to
//   `:root` via `setProperty`. There is no React state behind any
//   styled component — only CSS variables. That's what makes the
//   module fast (no React re-render on theme change) and portable
//   (no styling library is imposed on the host app).

/**
 * The semantic token set. Adding a token means: (a) declare its default
 * in `tokens.css`, (b) include it in every Preset in `presets.ts`, (c)
 * use it via `var(--token)` in your stylesheet.
 *
 * Names are application-agnostic. A consumer app may extend by defining
 * its own token names; the module accepts any string key in the preset
 * `tokens` map and applies it to `:root`.
 */
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
  | "font-code";

/** A preset's color/font assignments. Flat map keyed by token name. */
export type TokenMap = Partial<Record<TokenName, string>> & Record<string, string>;

/**
 * Preset = a named theme. `mode` is its base lightness; `mode: "auto"`
 * is reserved for the special "system" preset that picks light/dark at
 * runtime via `matchMedia`. All other presets have a literal mode.
 */
export type Theme = {
  id: string;
  name: string;
  mode: "light" | "dark";
  tokens: TokenMap;
};

/**
 * User-facing preferences — what gets persisted. Three layers:
 *   1. `presetId` — which built-in preset to base on. The literal string
 *      `"system"` means "follow OS preference" (resolves to Light or Dark
 *      at runtime).
 *   2. `overrides` — optional per-token color overrides on top of the
 *      preset. Empty in the default case.
 *   3. `fonts` — optional UI/code font family overrides.
 *
 * The module rebuilds the applied TokenMap as: preset.tokens ⊕ overrides
 * ⊕ font overrides. No deeper structure — adding a fourth layer (e.g.
 * per-component overrides) is a v2 concern.
 */
export type Preferences = {
  presetId: string;
  overrides?: {
    accent?: string;
    background?: string;
    foreground?: string;
  };
  fonts?: {
    ui?: string;
    code?: string;
  };
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
 *   - Both calls may be slow (HTTP, IPC). The ThemeProvider treats them
 *     as async; first paint uses a synchronous bootstrap (see `bootstrap`
 *     on ThemeProvider) so the user never sees a flash of unstyled
 *     content.
 */
export type Persistence = {
  load(): Promise<Preferences | null>;
  save(prefs: Preferences): Promise<void>;
};

/**
 * Result of applying a Preferences to a preset list. Exposed via
 * `useTheme()` so consumers can render the resolved theme name
 * (e.g. "Dark — auto" when system-follow chose Dark).
 */
export type ResolvedTheme = {
  preset: Theme;
  /** True when `Preferences.presetId === "system"` and a media query picked the mode. */
  fromSystem: boolean;
  /** The applied token map after overrides + fonts merge. */
  tokens: TokenMap;
};
