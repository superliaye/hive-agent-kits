// Cross-package drift detector for the Appearance wire shape.
//
// The UI's portable theming module defines `Preferences` (plain TS) as
// the canonical UI-side type. The daemon defines `AppearanceConfigSchema`
// (Zod, .strict()) as the canonical server-side validator. TypeScript
// cannot catch drift across packages — if either side gains a field
// without the other, the UI compiles, the daemon rejects, and the user
// sees a 400 with no static hint.
//
// This test exercises both directions:
//   1. A fully-populated UI-side `Preferences` value MUST pass the
//      Zod schema (asserts: UI shape is a subset/equal of server shape).
//   2. The Zod-inferred daemon shape MUST be assignable to the UI type
//      (asserts: server shape is a subset/equal of UI shape).
// Together: the shapes match.

import { describe, expect, test } from "bun:test";
import {
  APP_CONFIG_DEFAULTS,
  type AppearanceConfig,
  AppearanceConfigSchema,
  type ThemeConfig as ServerThemeConfig,
} from "../../config/schema.ts";
import { importPreferences } from "../../../ui/src/theming/serialize.ts";
import type { Preferences, ThemeConfig as UiThemeConfig } from "../../../ui/src/theming/types.ts";

describe("Appearance shape — UI ↔ daemon drift", () => {
  test("UI Preferences (fully populated) parses against daemon Zod schema", () => {
    const uiPrefs: Preferences = {
      mode: "dark",
      light: {
        themeId: "github-light",
        accent: "#0969da",
        background: "#ffffff",
        foreground: "#1f2328",
        fontUi: '"Inter", system-ui, sans-serif',
        fontCode: '"Fira Code", monospace',
        fontUiSize: 15,
        fontCodeSize: 13,
        contrast: 50,
        translucentSidebar: false,
      },
      dark: {
        themeId: "dracula",
        accent: "#bd93f9",
        background: "#282a36",
        foreground: "#f8f8f2",
        fontUi: '"Inter", system-ui, sans-serif',
        fontCode: '"Fira Code", monospace',
        fontUiSize: 16,
        fontCodeSize: 14,
        contrast: 65,
        translucentSidebar: true,
      },
      reduceMotion: "on",
      pointerCursors: true,
      useSystemAccent: true,
    };
    // If the UI added a field the server doesn't allow, .strict() rejects.
    // If the server demanded a field the UI didn't supply, the parse fails.
    expect(() => AppearanceConfigSchema.parse(uiPrefs)).not.toThrow();
  });

  test("daemon AppearanceConfig is assignable to UI Preferences (compile-time)", () => {
    // If this assignment compiles, the daemon's Zod-inferred shape is
    // structurally compatible with the UI's portable type. If the daemon
    // gains a field the UI doesn't declare, TS errors here.
    const sample: AppearanceConfig = {
      mode: "system",
      light: {},
      dark: {},
      reduceMotion: "system",
      pointerCursors: false,
      useSystemAccent: false,
    };
    const asUi: Preferences = sample;
    expect(asUi.mode).toBe("system");
  });

  test("ThemeConfig types are structurally compatible both ways", () => {
    const ui: UiThemeConfig = {
      themeId: "monokai",
      accent: "#f92672",
      fontUiSize: 14,
      contrast: 75,
    };
    const server: ServerThemeConfig = ui;
    const backToUi: UiThemeConfig = server;
    expect(backToUi.themeId).toBe("monokai");
  });

  // BOUNDS drift, not just shape drift. A user pasting a theme JSON
  // shouldn't see "accepted by importPreferences, then rejected with
  // 400 on save" — the two validators must agree on min/max bounds.
  describe("UI importPreferences and Zod schema agree on bounds", () => {
    const baseValid = APP_CONFIG_DEFAULTS.appearance;

    function wrap(prefs: AppearanceConfig): string {
      return JSON.stringify({ version: 1, preferences: prefs });
    }
    function uiAccepts(prefs: AppearanceConfig): boolean {
      return importPreferences(wrap(prefs)).ok;
    }
    function serverAccepts(prefs: unknown): boolean {
      return AppearanceConfigSchema.safeParse(prefs).success;
    }

    // (label, mutator, expected accept) — both validators MUST agree.
    const cases: Array<[string, AppearanceConfig, boolean]> = [
      ["valid baseline", baseValid, true],
      [
        "fontUiSize at min (8)",
        { ...baseValid, light: { fontUiSize: 8 } },
        true,
      ],
      [
        "fontUiSize at max (48)",
        { ...baseValid, light: { fontUiSize: 48 } },
        true,
      ],
      [
        "fontUiSize below min (7)",
        { ...baseValid, light: { fontUiSize: 7 } },
        false,
      ],
      [
        "fontUiSize above max (49)",
        { ...baseValid, light: { fontUiSize: 49 } },
        false,
      ],
      [
        "fontUiSize non-integer (15.5)",
        { ...baseValid, dark: { fontUiSize: 15.5 } },
        false,
      ],
      [
        "contrast at min (0)",
        { ...baseValid, dark: { contrast: 0 } },
        true,
      ],
      [
        "contrast at max (100)",
        { ...baseValid, dark: { contrast: 100 } },
        true,
      ],
      [
        "contrast below min (-1)",
        { ...baseValid, dark: { contrast: -1 } },
        false,
      ],
      [
        "contrast above max (101)",
        { ...baseValid, dark: { contrast: 101 } },
        false,
      ],
      [
        "accent at max length (64)",
        { ...baseValid, dark: { accent: "a".repeat(64) } },
        true,
      ],
      [
        "accent over max length (65)",
        { ...baseValid, dark: { accent: "a".repeat(65) } },
        false,
      ],
      [
        "fontUi at max length (256)",
        { ...baseValid, light: { fontUi: "a".repeat(256) } },
        true,
      ],
      [
        "fontUi over max length (257)",
        { ...baseValid, light: { fontUi: "a".repeat(257) } },
        false,
      ],
    ];

    for (const [label, prefs, expected] of cases) {
      test(label, () => {
        const ui = uiAccepts(prefs);
        const server = serverAccepts(prefs);
        expect(ui).toBe(expected);
        expect(server).toBe(expected);
        expect(ui).toBe(server);
      });
    }
  });
});
