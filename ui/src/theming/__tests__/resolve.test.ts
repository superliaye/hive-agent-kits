// Tests for the pure theming math extracted from ThemeProvider.
// No React, no DOM — call the function, compare the object.

import { describe, expect, test } from "bun:test";
import { DARK_THEMES, LIGHT_THEMES } from "../presets.ts";
import { resolveMode, resolveReduceMotion, resolveTokens } from "../resolve.ts";
import type { Preferences } from "../types.ts";

const DEFAULTS: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
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
