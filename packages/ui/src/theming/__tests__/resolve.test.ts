// Tests for the pure theming math extracted from ThemeProvider.
// No React, no DOM — call the function, compare the object.

import { describe, expect, test } from "bun:test";
import { hexToHue, hueDelta, MIN_HUE_DELTA } from "../hue.ts";
import {
  DARK_THEMES,
  DEFAULT_STATUS_RUNNING_LIGHT,
  LIGHT_THEMES,
  STATUS_RUNNING_SAFE_ALT_DARK,
  STATUS_RUNNING_SAFE_ALT_LIGHT,
} from "../presets.ts";
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

// Test-only color math, shared across the hue-distinctness and contrast blocks.
// Kept here (not in production hue.ts) — these are assertion wrappers and WCAG
// helpers the resolver never needs.

// Hue distance between two hex colors; fails the test if either is achromatic
// (we only call it on chromatic inputs, where a null would be a real bug).
function deltaOf(a: string, b: string): number {
  const ha = hexToHue(a);
  const hb = hexToHue(b);
  expect(ha).not.toBeNull();
  expect(hb).not.toBeNull();
  if (ha === null || hb === null) throw new Error("expected chromatic colors");
  return hueDelta(ha, hb);
}

// WCAG relative luminance + contrast ratio for two #rrggbb colors.
function relLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = chan((n >> 16) & 0xff);
  const g = chan((n >> 8) & 0xff);
  const b = chan(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

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
    const config = resolveEffectiveConfig({ ...DEFAULTS, useSystemAccent: true }, base, "#ff8800");
    expect(config.accent).toBe("#ff8800");
    expect(config.themeId).toBe("dracula");
  });
  test("returns base config unchanged when not opted in", () => {
    const config = resolveEffectiveConfig({ ...DEFAULTS, useSystemAccent: false }, base, "#ff8800");
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
  // The 20 TokenName keys (types.ts). resolveTokens layers the named
  // palette (15 colors + font-ui/font-code via the helper) and always adds
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
    "color-status-running",
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

// The running status dot must be distinguishable by HUE from unread (accent)
// and failed (danger) in every theme — not just by shape. Guard the hue
// separation so a future palette edit can't silently collapse the running state
// back into the accent or danger color.
describe("color-status-running is hue-distinct from accent and danger in every theme", () => {
  function assertDistinct(themeId: string, mode: "light" | "dark"): void {
    const tokens = resolveTokens({ themeId }, mode);
    const running = hexToHue(tokens["color-status-running"] ?? "");
    const accent = hexToHue(tokens["color-accent"] ?? "");
    const danger = hexToHue(tokens["color-danger"] ?? "");
    // Achromatic accent/danger (null hue) can't collide with our chromatic
    // running hue, so only assert when both have a defined hue.
    if (running !== null && accent !== null) {
      expect(hueDelta(running, accent)).toBeGreaterThanOrEqual(MIN_HUE_DELTA);
    }
    if (running !== null && danger !== null) {
      expect(hueDelta(running, danger)).toBeGreaterThanOrEqual(MIN_HUE_DELTA);
    }
  }

  for (const theme of LIGHT_THEMES) {
    test(`light "${theme.id}"`, () => assertDistinct(theme.id, "light"));
  }
  for (const theme of DARK_THEMES) {
    test(`dark "${theme.id}"`, () => assertDistinct(theme.id, "dark"));
  }
});

// C1a — the running hue must stay distinct even when the user (or the OS, via
// useSystemAccent) overrides `--color-accent` with a warm hue that collides with
// the amber running default. The nudge in resolveTokens falls running back to a
// safe alt hue only when it actually collides; a non-colliding accent leaves the
// theme default untouched, and an achromatic accent never fires the nudge.
describe("resolveTokens — running hue is guarded against the accent override", () => {
  const DEFAULT_DARK_RUNNING = DARK_THEMES.find((t) => t.id === "default-dark")?.palette.tokens[
    "color-status-running"
  ];

  test("a warm accent override collides with the amber running default (proves the gap)", () => {
    // Without the nudge, the raw amber default sits < MIN_HUE_DELTA from a warm
    // (amber/orange) accent — the collision the guard exists to prevent.
    const rawRunning =
      resolveTokens({ themeId: "default-dark" }, "dark")["color-status-running"] ?? "";
    expect(deltaOf(rawRunning, "#f5a623")).toBeLessThan(MIN_HUE_DELTA);
  });

  test("colliding warm accent → running falls back to the safe alt hue, ≥ MIN_HUE_DELTA", () => {
    for (const accent of ["#f5a623", "#ff8c42"]) {
      const tokens = resolveTokens({ themeId: "default-dark", accent }, "dark");
      expect(tokens["color-status-running"]).toBe(STATUS_RUNNING_SAFE_ALT_DARK);
      expect(deltaOf(tokens["color-status-running"] ?? "", accent)).toBeGreaterThanOrEqual(
        MIN_HUE_DELTA,
      );
    }
  });

  test("non-colliding accent → running stays at the theme default (nudge does not over-fire)", () => {
    const tokens = resolveTokens({ themeId: "default-dark", accent: "#4a8eff" }, "dark");
    expect(tokens["color-status-running"]).toBe(DEFAULT_DARK_RUNNING);
  });

  test("nudge also guards against a danger collision", () => {
    // A warm accent triggers the fallback; assert running ends up ≥ MIN_HUE_DELTA
    // from BOTH accent and danger.
    const tokens = resolveTokens({ themeId: "default-dark", accent: "#f5a623" }, "dark");
    const running = tokens["color-status-running"] ?? "";
    expect(deltaOf(running, "#f5a623")).toBeGreaterThanOrEqual(MIN_HUE_DELTA);
    expect(deltaOf(running, tokens["color-danger"] ?? "")).toBeGreaterThanOrEqual(MIN_HUE_DELTA);
  });

  test("achromatic accent (grey) never nudges — running keeps its theme default", () => {
    const tokens = resolveTokens({ themeId: "default-dark", accent: "#808080" }, "dark");
    expect(tokens["color-status-running"]).toBe(DEFAULT_DARK_RUNNING);
  });
});

// The single safe-alt cyan is mode-blind, but the C1a nudge fires in BOTH modes.
// On a light theme the original dark cyan dropped to ~1.7:1 against the near-white
// bg — far below the 3:1 non-text-UI minimum. The safe-alt is split per mode
// (mirroring DEFAULT_STATUS_RUNNING_LIGHT/_DARK); the nudge picks the mode-matched
// literal. Hue distinctness is already covered above — this guards luminance.
describe("resolveTokens — light-mode running safe-alt is contrast-legible", () => {
  // Pure white is the brightest possible bg and the true worst case for the 3:1
  // floor — brighter than default-light's #f5f5f7. Several shipped light themes
  // (github-light, notion-light, xcode-light) use #ffffff exactly, and the nudge
  // is mode-keyed but theme-agnostic, so it fires the same light safe-alt on all
  // of them. Pinning #ffffff guards every light theme, not just default-light.
  const BRIGHTEST_LIGHT_BG = "#ffffff";

  test("the dark safe-alt fails 3:1 on the brightest light bg (proves the gap)", () => {
    // This is what the mode-blind single cyan rendered on light themes — the
    // legibility regression the mode-aware split fixes.
    expect(contrast(STATUS_RUNNING_SAFE_ALT_DARK, BRIGHTEST_LIGHT_BG)).toBeLessThan(3);
  });

  test("colliding warm accent in light mode → running falls back to the light safe-alt, ≥3:1", () => {
    for (const accent of ["#f5a623", "#ff8c42"]) {
      const tokens = resolveTokens({ themeId: "default-light", accent }, "light");
      expect(tokens["color-status-running"]).toBe(STATUS_RUNNING_SAFE_ALT_LIGHT);
    }
    // The fixed light safe-alt must clear 3:1 against the brightest possible light
    // bg — so a future retune toward a lighter cyan can't drop below the floor on
    // the near-white themes with no test failing.
    expect(contrast(STATUS_RUNNING_SAFE_ALT_LIGHT, BRIGHTEST_LIGHT_BG)).toBeGreaterThanOrEqual(3);
  });

  test("the light safe-alt stays hue-distinct from warm accents and danger", () => {
    const tokens = resolveTokens({ themeId: "default-light", accent: "#f5a623" }, "light");
    const running = tokens["color-status-running"] ?? "";
    expect(running).toBe(STATUS_RUNNING_SAFE_ALT_LIGHT);
    for (const accent of ["#f5a623", "#ff8c42"]) {
      expect(deltaOf(running, accent)).toBeGreaterThanOrEqual(MIN_HUE_DELTA);
    }
    expect(deltaOf(running, tokens["color-danger"] ?? "")).toBeGreaterThanOrEqual(MIN_HUE_DELTA);
  });

  test("non-colliding accent in light mode → running stays at the theme default", () => {
    const tokens = resolveTokens({ themeId: "default-light", accent: "#4a8eff" }, "light");
    expect(tokens["color-status-running"]).toBe(DEFAULT_STATUS_RUNNING_LIGHT);
  });

  test("achromatic accent in light mode never nudges — running keeps its theme default", () => {
    const tokens = resolveTokens({ themeId: "default-light", accent: "#808080" }, "light");
    expect(tokens["color-status-running"]).toBe(DEFAULT_STATUS_RUNNING_LIGHT);
  });
});

// C2a — the TS running-default literal must equal the value the resolver
// actually injects for the default light theme, so the constant can't silently
// drift from the resolved color (the CSS :root fallback in tokens.css mirrors it
// by adjacency).
describe("DEFAULT_STATUS_RUNNING_LIGHT pins the resolved default-light running token", () => {
  test("constant equals the injected value", () => {
    const tokens = resolveTokens({ themeId: "default-light" }, "light");
    expect(tokens["color-status-running"]).toBe(DEFAULT_STATUS_RUNNING_LIGHT);
  });
});
