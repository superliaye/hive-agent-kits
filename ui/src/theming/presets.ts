// Named theme presets — curated palettes the user picks from. One list
// per mode (Light/Dark). Each entry is a full TokenMap for its mode.
//
// Picking a named theme sets `ThemeConfig.themeId`; user overrides
// (accent/background/foreground/fonts) layer on top inside ThemeProvider.
//
// All entries target WCAG AA for body text. Spot-check via
// webaim.org/resources/contrastchecker/ before adding a new one.

import type { ModePalette, ResolvedMode, TokenMap } from "./types.ts";

export const DEFAULT_FONT_UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const DEFAULT_FONT_CODE =
  '"SF Mono", "JetBrains Mono", "Cascadia Code", "Consolas", "Liberation Mono", monospace';
export const DEFAULT_FONT_UI_SIZE = 14;
export const DEFAULT_FONT_CODE_SIZE = 13;
export const DEFAULT_CONTRAST = 50;

export type NamedTheme = {
  id: string;
  name: string;
  palette: ModePalette;
};

function light(tokens: Omit<TokenMap, "font-ui" | "font-code">): ModePalette {
  return {
    mode: "light",
    tokens: { ...tokens, "font-ui": DEFAULT_FONT_UI, "font-code": DEFAULT_FONT_CODE },
  };
}
function dark(tokens: Omit<TokenMap, "font-ui" | "font-code">): ModePalette {
  return {
    mode: "dark",
    tokens: { ...tokens, "font-ui": DEFAULT_FONT_UI, "font-code": DEFAULT_FONT_CODE },
  };
}

export const LIGHT_THEMES: readonly NamedTheme[] = [
  {
    id: "default-light",
    name: "Default",
    palette: light({
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
    }),
  },
  {
    id: "github-light",
    name: "GitHub Light",
    palette: light({
      "color-bg-base": "#ffffff",
      "color-bg-surface": "#f6f8fa",
      "color-bg-elevated": "#ffffff",
      "color-bg-hover": "#eaeef2",
      "color-fg-default": "#1f2328",
      "color-fg-muted": "#656d76",
      "color-fg-on-accent": "#ffffff",
      "color-accent": "#0969da",
      "color-accent-hover": "#218bff",
      "color-border-default": "#d0d7de",
      "color-border-strong": "#afb8c1",
      "color-danger": "#cf222e",
      "color-warning": "#9a6700",
      "color-success": "#1a7f37",
    }),
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    palette: light({
      "color-bg-base": "#fdf6e3",
      "color-bg-surface": "#eee8d5",
      "color-bg-elevated": "#eee8d5",
      "color-bg-hover": "#e4dec3",
      "color-fg-default": "#586e75",
      "color-fg-muted": "#93a1a1",
      "color-fg-on-accent": "#fdf6e3",
      "color-accent": "#268bd2",
      "color-accent-hover": "#4a9dd9",
      "color-border-default": "#d8d0b8",
      "color-border-strong": "#c8c0a8",
      "color-danger": "#dc322f",
      "color-warning": "#b58900",
      "color-success": "#859900",
    }),
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    palette: light({
      "color-bg-base": "#eff1f5",
      "color-bg-surface": "#e6e9ef",
      "color-bg-elevated": "#dce0e8",
      "color-bg-hover": "#ccd0da",
      "color-fg-default": "#4c4f69",
      "color-fg-muted": "#6c6f85",
      "color-fg-on-accent": "#eff1f5",
      "color-accent": "#1e66f5",
      "color-accent-hover": "#3a7df7",
      "color-border-default": "#ccd0da",
      "color-border-strong": "#bcc0cc",
      "color-danger": "#d20f39",
      "color-warning": "#df8e1d",
      "color-success": "#40a02b",
    }),
  },
];

export const DARK_THEMES: readonly NamedTheme[] = [
  {
    id: "default-dark",
    name: "Default",
    palette: dark({
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
    }),
  },
  {
    id: "dim",
    name: "Dim",
    palette: dark({
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
    }),
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    palette: dark({
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
    }),
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    palette: dark({
      "color-bg-base": "#002b36",
      "color-bg-surface": "#073642",
      "color-bg-elevated": "#0a4250",
      "color-bg-hover": "#094350",
      "color-fg-default": "#93a1a1",
      "color-fg-muted": "#657b83",
      "color-fg-on-accent": "#002b36",
      "color-accent": "#268bd2",
      "color-accent-hover": "#4a9dd9",
      "color-border-default": "#1a4f5c",
      "color-border-strong": "#2a5f6c",
      "color-danger": "#dc322f",
      "color-warning": "#b58900",
      "color-success": "#859900",
    }),
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    palette: dark({
      "color-bg-base": "#1e1e2e",
      "color-bg-surface": "#181825",
      "color-bg-elevated": "#313244",
      "color-bg-hover": "#45475a",
      "color-fg-default": "#cdd6f4",
      "color-fg-muted": "#a6adc8",
      "color-fg-on-accent": "#1e1e2e",
      "color-accent": "#cba6f7",
      "color-accent-hover": "#dbb8ff",
      "color-border-default": "#45475a",
      "color-border-strong": "#585b70",
      "color-danger": "#f38ba8",
      "color-warning": "#f9e2af",
      "color-success": "#a6e3a1",
    }),
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    palette: dark({
      "color-bg-base": "#1a1b26",
      "color-bg-surface": "#24283b",
      "color-bg-elevated": "#2e3146",
      "color-bg-hover": "#2e3146",
      "color-fg-default": "#c0caf5",
      "color-fg-muted": "#565f89",
      "color-fg-on-accent": "#1a1b26",
      "color-accent": "#7aa2f7",
      "color-accent-hover": "#92b4ff",
      "color-border-default": "#2e3146",
      "color-border-strong": "#3b3e58",
      "color-danger": "#f7768e",
      "color-warning": "#e0af68",
      "color-success": "#9ece6a",
    }),
  },
  {
    id: "dracula",
    name: "Dracula",
    palette: dark({
      "color-bg-base": "#282a36",
      "color-bg-surface": "#2e3140",
      "color-bg-elevated": "#44475a",
      "color-bg-hover": "#44475a",
      "color-fg-default": "#f8f8f2",
      "color-fg-muted": "#6272a4",
      "color-fg-on-accent": "#282a36",
      "color-accent": "#bd93f9",
      "color-accent-hover": "#d6b0ff",
      "color-border-default": "#44475a",
      "color-border-strong": "#5b5e75",
      "color-danger": "#ff5555",
      "color-warning": "#f1fa8c",
      "color-success": "#50fa7b",
    }),
  },
  {
    id: "monokai",
    name: "Monokai",
    palette: dark({
      "color-bg-base": "#272822",
      "color-bg-surface": "#3e3d32",
      "color-bg-elevated": "#49483e",
      "color-bg-hover": "#49483e",
      "color-fg-default": "#f8f8f2",
      "color-fg-muted": "#a59f85",
      "color-fg-on-accent": "#272822",
      "color-accent": "#f92672",
      "color-accent-hover": "#fb4288",
      "color-border-default": "#49483e",
      "color-border-strong": "#5c5b50",
      "color-danger": "#f92672",
      "color-warning": "#fd971f",
      "color-success": "#a6e22e",
    }),
  },
];

// Convenience aliases for the historical names.
export const LIGHT_PALETTE: ModePalette = LIGHT_THEMES[0].palette;
export const DARK_PALETTE: ModePalette = DARK_THEMES[0].palette;

export function namedThemesFor(mode: ResolvedMode): readonly NamedTheme[] {
  return mode === "dark" ? DARK_THEMES : LIGHT_THEMES;
}

export function findNamedTheme(mode: ResolvedMode, id: string | undefined): NamedTheme {
  const list = namedThemesFor(mode);
  if (id) {
    const found = list.find((t) => t.id === id);
    if (found) return found;
  }
  return list[0];
}

export function paletteFor(mode: ResolvedMode): ModePalette {
  return mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

/**
 * Suggested font stacks for datalist-style auto-complete. Not a hard
 * allowlist — users can type any CSS font-family stack.
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
