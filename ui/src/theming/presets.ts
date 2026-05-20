// Default per-mode palettes. The theming module ships just two — Light
// and Dark — that supply baseline token values. Per-mode ThemeConfig
// overrides on top of these.
//
// Both palettes pass WCAG AA contrast for fg/bg pairs:
//   - color-fg-default on color-bg-base  ≥ 4.5:1
//   - color-fg-muted on color-bg-base    ≥ 4.5:1
//   - color-fg-on-accent on color-accent ≥ 4.5:1

import type { ModePalette, ResolvedMode } from "./types.ts";

export const DEFAULT_FONT_UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const DEFAULT_FONT_CODE =
  '"SF Mono", "JetBrains Mono", "Cascadia Code", "Consolas", "Liberation Mono", monospace';
export const DEFAULT_FONT_UI_SIZE = 14;
export const DEFAULT_FONT_CODE_SIZE = 13;
export const DEFAULT_CONTRAST = 50;

export const LIGHT_PALETTE: ModePalette = {
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
    "font-ui": DEFAULT_FONT_UI,
    "font-code": DEFAULT_FONT_CODE,
  },
};

export const DARK_PALETTE: ModePalette = {
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
    "font-ui": DEFAULT_FONT_UI,
    "font-code": DEFAULT_FONT_CODE,
  },
};

export function paletteFor(mode: ResolvedMode): ModePalette {
  return mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

/**
 * Suggested font stacks for datalist-style auto-complete. Not a hard
 * allowlist — users can type any CSS font-family stack into the inputs.
 */
export const FONT_SUGGESTIONS = {
  ui: [
    { name: "System", value: DEFAULT_FONT_UI },
    { name: "Inter", value: '"Inter", system-ui, sans-serif' },
    { name: "IBM Plex Sans", value: '"IBM Plex Sans", system-ui, sans-serif' },
    { name: "Georgia", value: 'Georgia, "Times New Roman", serif' },
  ],
  code: [
    { name: "System Mono", value: DEFAULT_FONT_CODE },
    { name: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
    { name: "Fira Code", value: '"Fira Code", monospace' },
    { name: "IBM Plex Mono", value: '"IBM Plex Mono", monospace' },
  ],
} as const;
