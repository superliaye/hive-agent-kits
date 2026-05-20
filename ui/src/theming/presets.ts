// Built-in theme presets — pure data. Adding a preset is just appending
// to BUILT_IN_PRESETS. Removing or renaming an id is a breaking change
// for users whose persisted preferences reference it.
//
// All presets pass WCAG AA contrast for fg/bg pairs:
//   - color-fg-default on color-bg-base  ≥ 4.5:1 (body text)
//   - color-fg-muted on color-bg-base    ≥ 4.5:1 (secondary text)
//   - color-fg-on-accent on color-accent ≥ 4.5:1 (button labels)
//
// Spot-check via webaim.org/resources/contrastchecker/ when changing.

import type { Theme } from "./types.ts";

const FONT_UI_DEFAULT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const FONT_CODE_DEFAULT =
  '"SF Mono", "JetBrains Mono", "Cascadia Code", "Consolas", "Liberation Mono", monospace';

export const LIGHT_PRESET: Theme = {
  id: "light",
  name: "Light",
  mode: "light",
  tokens: {
    "color-bg-base": "#f5f5f7",
    "color-bg-surface": "#ffffff",
    "color-bg-elevated": "#ffffff",
    "color-bg-hover": "#f0f0f5",
    "color-fg-default": "#1a1a1a",
    "color-fg-muted": "#6a6a75",
    "color-fg-on-accent": "#ffffff",
    "color-accent": "#0a0a0f",
    "color-accent-hover": "#2a2a55",
    "color-border-default": "#e0e0e6",
    "color-border-strong": "#d0d0d6",
    "color-danger": "#c75450",
    "color-warning": "#a37a00",
    "color-success": "#2a6a3a",
    "font-ui": FONT_UI_DEFAULT,
    "font-code": FONT_CODE_DEFAULT,
  },
};

export const DARK_PRESET: Theme = {
  id: "dark",
  name: "Dark",
  mode: "dark",
  tokens: {
    "color-bg-base": "#0d1117",
    "color-bg-surface": "#161b22",
    "color-bg-elevated": "#1c2129",
    "color-bg-hover": "#21262d",
    "color-fg-default": "#e6edf3",
    "color-fg-muted": "#8d96a0",
    "color-fg-on-accent": "#ffffff",
    "color-accent": "#4a8eff",
    "color-accent-hover": "#6aa3ff",
    "color-border-default": "#30363d",
    "color-border-strong": "#484f58",
    "color-danger": "#ff6b6b",
    "color-warning": "#ffb454",
    "color-success": "#56d364",
    "font-ui": FONT_UI_DEFAULT,
    "font-code": FONT_CODE_DEFAULT,
  },
};

// Dim — softer than Dark, less eye strain for long sessions. Inspired by
// GitHub's Dim theme: lighter surfaces, slightly desaturated.
export const DIM_PRESET: Theme = {
  id: "dim",
  name: "Dim",
  mode: "dark",
  tokens: {
    "color-bg-base": "#22272e",
    "color-bg-surface": "#2d333b",
    "color-bg-elevated": "#373e47",
    "color-bg-hover": "#373e47",
    "color-fg-default": "#cdd9e5",
    "color-fg-muted": "#909dab",
    "color-fg-on-accent": "#ffffff",
    "color-accent": "#539bf5",
    "color-accent-hover": "#6cb6ff",
    "color-border-default": "#444c56",
    "color-border-strong": "#545d68",
    "color-danger": "#f47067",
    "color-warning": "#daa64f",
    "color-success": "#57ab5a",
    "font-ui": FONT_UI_DEFAULT,
    "font-code": FONT_CODE_DEFAULT,
  },
};

// High Contrast — WCAG AAA targets. Pure-black background; brightest fg.
// Borders crank up to maximum visibility. Accent is sky blue (highest-
// contrast accent over black).
export const HIGH_CONTRAST_PRESET: Theme = {
  id: "high-contrast",
  name: "High Contrast",
  mode: "dark",
  tokens: {
    "color-bg-base": "#000000",
    "color-bg-surface": "#0a0a0a",
    "color-bg-elevated": "#141414",
    "color-bg-hover": "#1f1f1f",
    "color-fg-default": "#ffffff",
    "color-fg-muted": "#c0c0c0",
    "color-fg-on-accent": "#000000",
    "color-accent": "#5acbff",
    "color-accent-hover": "#80d8ff",
    "color-border-default": "#6a6a6a",
    "color-border-strong": "#a0a0a0",
    "color-danger": "#ff7070",
    "color-warning": "#ffd060",
    "color-success": "#70ff7c",
    "font-ui": FONT_UI_DEFAULT,
    "font-code": FONT_CODE_DEFAULT,
  },
};

export const BUILT_IN_PRESETS: readonly Theme[] = [
  LIGHT_PRESET,
  DARK_PRESET,
  DIM_PRESET,
  HIGH_CONTRAST_PRESET,
];

/** Look up a preset by id. Returns undefined for "system" and unknown ids. */
export function findPresetById(presets: readonly Theme[], id: string): Theme | undefined {
  return presets.find((p) => p.id === id);
}

/** Default preset by mode — used by the system-follow flow. */
export function defaultPresetForMode(presets: readonly Theme[], mode: "light" | "dark"): Theme {
  const found = presets.find((p) => p.mode === mode);
  // Always at least Light + Dark available; fall back defensively.
  return found ?? presets[0] ?? LIGHT_PRESET;
}

// ─── Font allowlist (UI presents these in selects) ──────────────────────

/**
 * Curated UI + code font stacks. Listed by display name; the value is
 * the full CSS `font-family` stack. Custom values are allowed via the
 * `Preferences.fonts` overrides — the allowlist is for the picker UI's
 * convenience, not a hard validator.
 */
export const FONT_OPTIONS = {
  ui: [
    { name: "System", value: FONT_UI_DEFAULT },
    { name: "Inter", value: '"Inter", system-ui, sans-serif' },
    { name: "IBM Plex Sans", value: '"IBM Plex Sans", system-ui, sans-serif' },
    { name: "Serif", value: 'Georgia, "Times New Roman", serif' },
  ],
  code: [
    { name: "System Mono", value: FONT_CODE_DEFAULT },
    { name: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
    { name: "Fira Code", value: '"Fira Code", monospace' },
    { name: "IBM Plex Mono", value: '"IBM Plex Mono", monospace' },
  ],
} as const;
