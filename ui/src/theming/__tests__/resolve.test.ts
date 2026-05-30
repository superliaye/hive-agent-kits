// Tests for the pure theming math extracted from ThemeProvider.
// No React, no DOM — call the function, compare the object.

import { describe, expect, test } from "bun:test";
import { DARK_THEMES, LIGHT_THEMES } from "../presets.ts";
import {
  resolveEffectiveConfig,
  resolveMode,
  resolveReduceMotion,
  resolveTokens,
} from "../resolve.ts";
import type { Preferences } from "../types.ts";

const DEFAULTS: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
  useSystemAccent: false,
};

describe("resolveMode", () => {
  test("returns concrete mode when prefs is light/dark", () => {
    expect(resolveMode({ ...DEFAULTS, mode: "light" }, "dark")).toBe("light");
    expect(resolveMode({ ...DEFAULTS, mode: "dark" }, "light")).toBe("dark");
  });
  test("returns systemMode when prefs is system", () => {
    expect(resolveMode({ ...DEFAULTS, mode: "system" }, "light")).toBe("light");
    expect(resolveMode({ ...DEFAULTS, mode: "system" }, "dark")).toBe("dark");
  });
});

describe("resolveTokens — named-theme lookup", () => {
  test("empty config + dark returns first dark theme's palette", () => {
    const tokens = resolveTokens({}, "dark");
    expect(tokens["color-bg-base"]).toBe(DARK_THEMES[0].palette.tokens["color-bg-base"]);
  });
  test("themeId picks the named palette", () => {
    const dracula = DARK_THEMES.find((t) => t.id === "dracula");
    expect(dracula).toBeDefined();
    const tokens = resolveTokens({ themeId: "dracula" }, "dark");
    expect(tokens["color-accent"]).toBe(dracula?.palette.tokens["color-accent"]);
  });
  test("unknown themeId falls back to first palette", () => {
    const tokens = resolveTokens({ themeId: "made-up-id" }, "light");
    expect(tokens["color-bg-base"]).toBe(LIGHT_THEMES[0].palette.tokens["color-bg-base"]);
  });
});

describe("resolveTokens — color/font overrides layer on top of palette", () => {
  test("accent override beats palette accent", () => {
    const tokens = resolveTokens({ themeId: "dracula", accent: "#ff00ff" }, "dark");
    expect(tokens["color-accent"]).toBe("#ff00ff");
  });
  test("background + foreground override palette", () => {
    const tokens = resolveTokens({ background: "#abc", foreground: "#def" }, "dark");
    expect(tokens["color-bg-base"]).toBe("#abc");
    expect(tokens["color-fg-default"]).toBe("#def");
  });
  test("fontUi/fontCode override palette stacks", () => {
    const tokens = resolveTokens({ fontUi: "Inter", fontCode: "Fira Code" }, "light");
    expect(tokens["font-ui"]).toBe("Inter");
    expect(tokens["font-code"]).toBe("Fira Code");
  });
});

describe("resolveTokens — font sizes", () => {
  test("default sizes when no config", () => {
    const tokens = resolveTokens({}, "light");
    expect(tokens["font-size-ui"]).toBe("14px");
    expect(tokens["font-size-code"]).toBe("13px");
  });
  test("explicit sizes format as px", () => {
    const tokens = resolveTokens({ fontUiSize: 16, fontCodeSize: 12 }, "dark");
    expect(tokens["font-size-ui"]).toBe("16px");
    expect(tokens["font-size-code"]).toBe("12px");
  });
});

describe("resolveTokens — contrast modulation", () => {
  test("contrast=50 (default) leaves palette muted color intact", () => {
    const tokens = resolveTokens({ contrast: 50 }, "dark");
    // Should equal the palette's hand-tuned muted color — no color-mix string.
    expect(tokens["color-fg-muted"]).toBe(DARK_THEMES[0].palette.tokens["color-fg-muted"]);
    expect(tokens["color-fg-muted"]?.startsWith("color-mix")).toBe(false);
  });
  test("contrast≠50 produces color-mix expressions for muted + borders", () => {
    const tokens = resolveTokens({ contrast: 80 }, "dark");
    expect(tokens["color-fg-muted"]?.startsWith("color-mix")).toBe(true);
    expect(tokens["color-border-default"]?.startsWith("color-mix")).toBe(true);
    expect(tokens["color-border-strong"]?.startsWith("color-mix")).toBe(true);
  });
  test("contrast is clamped to [0, 100]", () => {
    const high = resolveTokens({ contrast: 150 }, "dark");
    expect(high["color-fg-muted"]).toContain(" 100%");
    const low = resolveTokens({ contrast: -20 }, "dark");
    expect(low["color-fg-muted"]).toContain(" 0%");
  });
});

describe("resolveTokens — translucent sidebar", () => {
  test("default is opaque (1)", () => {
    expect(resolveTokens({}, "light")["sidebar-opacity"]).toBe("1");
  });
  test("translucent toggle → 0.78", () => {
    expect(resolveTokens({ translucentSidebar: true }, "light")["sidebar-opacity"]).toBe("0.78");
  });
});

describe("resolveEffectiveConfig", () => {
  const base = { themeId: "dracula", accent: "#111111" };
  test("system accent wins when opted in and available", () => {
    const config = resolveEffectiveConfig(
      { ...DEFAULTS, useSystemAccent: true },
      base,
      "#ff8800",
    );
    expect(config.accent).toBe("#ff8800");
    expect(config.themeId).toBe("dracula");
  });
  test("returns base config unchanged when not opted in", () => {
    const config = resolveEffectiveConfig(
      { ...DEFAULTS, useSystemAccent: false },
      base,
      "#ff8800",
    );
    expect(config).toBe(base);
  });
  test("returns base config unchanged when no system accent is available", () => {
    expect(resolveEffectiveConfig({ ...DEFAULTS, useSystemAccent: true }, base, null)).toBe(base);
    expect(resolveEffectiveConfig({ ...DEFAULTS, useSystemAccent: true }, base, undefined)).toBe(
      base,
    );
  });
  test("does not mutate the base config", () => {
    resolveEffectiveConfig({ ...DEFAULTS, useSystemAccent: true }, base, "#ff8800");
    expect(base.accent).toBe("#111111");
  });
});

describe("resolveReduceMotion", () => {
  test('explicit "on" / "off" win regardless of system', () => {
    expect(resolveReduceMotion({ ...DEFAULTS, reduceMotion: "on" }, false)).toBe("on");
    expect(resolveReduceMotion({ ...DEFAULTS, reduceMotion: "off" }, true)).toBe("off");
  });
  test('"system" defers to systemPrefersReduced', () => {
    expect(resolveReduceMotion({ ...DEFAULTS, reduceMotion: "system" }, true)).toBe("on");
    expect(resolveReduceMotion({ ...DEFAULTS, reduceMotion: "system" }, false)).toBe("off");
  });
});

// Catalog completeness — a shipped preset missing any color token would
// leave a hole in :root. Assert every named theme resolves the full set.
describe("resolveTokens — every shipped theme resolves a complete token map", () => {
  // The 19 TokenName keys (types.ts). resolveTokens layers the named
  // palette (14 colors + font-ui/font-code via the helper) and always adds
  // font-size-ui, font-size-code, sidebar-opacity.
  const ALL_TOKENS = [
    "color-bg-base",
    "color-bg-surface",
    "color-bg-elevated",
    "color-bg-hover",
    "color-fg-default",
    "color-fg-muted",
    "color-fg-on-accent",
    "color-accent",
    "color-accent-hover",
    "color-border-default",
    "color-border-strong",
    "color-danger",
    "color-warning",
    "color-success",
    "font-ui",
    "font-code",
    "font-size-ui",
    "font-size-code",
    "sidebar-opacity",
  ] as const;

  for (const theme of LIGHT_THEMES) {
    test(`light "${theme.id}" resolves all ${ALL_TOKENS.length} tokens`, () => {
      const tokens = resolveTokens({ themeId: theme.id }, "light");
      for (const key of ALL_TOKENS) expect(tokens[key]).toBeTruthy();
    });
  }
  for (const theme of DARK_THEMES) {
    test(`dark "${theme.id}" resolves all ${ALL_TOKENS.length} tokens`, () => {
      const tokens = resolveTokens({ themeId: theme.id }, "dark");
      for (const key of ALL_TOKENS) expect(tokens[key]).toBeTruthy();
    });
  }
});
