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
  type AppearanceConfig,
  AppearanceConfigSchema,
  type ThemeConfig as ServerThemeConfig,
} from "../../config/schema.ts";
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
});
