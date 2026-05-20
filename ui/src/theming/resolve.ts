// Pure functions that resolve a user's Preferences into the final
// TokenMap applied to `:root`. Extracted from ThemeProvider so the
// theming math (palette lookup, override merging, contrast modulation
// via color-mix, font-size px formatting, sidebar opacity) is testable
// and callable from any context — no React, no DOM.

import {
  DEFAULT_CONTRAST,
  DEFAULT_FONT_CODE_SIZE,
  DEFAULT_FONT_UI_SIZE,
  findNamedTheme,
} from "./presets.ts";
import type { Mode, Preferences, ResolvedMode, ThemeConfig, TokenMap } from "./types.ts";

/**
 * Pick the concrete mode the app renders in. `"system"` resolves via
 * the caller-supplied systemMode (a `matchMedia("(prefers-color-scheme:
 * dark)")` read). Pure function — no I/O.
 */
export function resolveMode(prefs: Preferences, systemMode: ResolvedMode): ResolvedMode {
  if (prefs.mode === "light" || prefs.mode === "dark") return prefs.mode;
  return systemMode;
}

/**
 * Layer the per-mode `ThemeConfig` on top of its named-theme palette
 * and produce the final `TokenMap` to apply to `:root`. Returns a fresh
 * object; safe to mutate the result.
 *
 * Order: named-palette defaults → color overrides → font overrides →
 * font-size tokens → contrast modulation (only when ≠ DEFAULT_CONTRAST)
 * → sidebar opacity.
 */
export function resolveTokens(config: ThemeConfig, mode: ResolvedMode): TokenMap {
  const palette = findNamedTheme(mode, config.themeId).palette;
  const tokens: TokenMap = { ...palette.tokens };

  if (config.accent) tokens["color-accent"] = config.accent;
  if (config.background) tokens["color-bg-base"] = config.background;
  if (config.foreground) tokens["color-fg-default"] = config.foreground;
  if (config.fontUi) tokens["font-ui"] = config.fontUi;
  if (config.fontCode) tokens["font-code"] = config.fontCode;

  const uiSize = config.fontUiSize ?? DEFAULT_FONT_UI_SIZE;
  const codeSize = config.fontCodeSize ?? DEFAULT_FONT_CODE_SIZE;
  tokens["font-size-ui"] = `${uiSize}px`;
  tokens["font-size-code"] = `${codeSize}px`;

  // Contrast: blend fg-default toward bg-base. 100 = pure fg-default
  // (max contrast), 0 = pure bg-base (no contrast). Only applied when
  // the user moved the slider — at DEFAULT_CONTRAST we trust the named
  // palette's hand-tuned muted/border colors.
  const contrast = config.contrast ?? DEFAULT_CONTRAST;
  if (contrast !== DEFAULT_CONTRAST) {
    const clamped = Math.max(0, Math.min(100, contrast));
    const fg = tokens["color-fg-default"] ?? "#000000";
    const bg = tokens["color-bg-base"] ?? "#ffffff";
    tokens["color-fg-muted"] = `color-mix(in srgb, ${fg} ${clamped}%, ${bg})`;
    // Borders track contrast proportionally — much lower percent so
    // they don't visually compete with body text but still respond.
    const borderPct = Math.max(10, Math.round(clamped * 0.32));
    tokens["color-border-default"] = `color-mix(in srgb, ${fg} ${borderPct}%, ${bg})`;
    const strongPct = Math.max(20, Math.round(clamped * 0.5));
    tokens["color-border-strong"] = `color-mix(in srgb, ${fg} ${strongPct}%, ${bg})`;
  }

  tokens["sidebar-opacity"] = config.translucentSidebar ? "0.78" : "1";

  return tokens;
}

/**
 * "Should we suppress animations?" — applied as `data-reduce-motion`
 * on `:root`. `"system"` defers to `prefers-reduced-motion`.
 */
export function resolveReduceMotion(prefs: Preferences, systemPrefersReduced: boolean): "on" | "off" {
  if (prefs.reduceMotion === "on") return "on";
  if (prefs.reduceMotion === "off") return "off";
  return systemPrefersReduced ? "on" : "off";
}

// Keep this alongside resolveTokens so the small "config helpers" stay
// in one place rather than scattered across the theming module.
export type { Mode, Preferences, ResolvedMode, ThemeConfig, TokenMap };
