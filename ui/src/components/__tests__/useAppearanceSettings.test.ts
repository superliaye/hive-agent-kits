// Pure-function coverage for the AppearanceSettings orchestration hook.
// The full hook needs a React tree to test (no React Testing Library
// in this project) — but `hasOverrides` is the load-bearing predicate
// that drives the "Modified" badge and the "Reset overrides" link, so
// pin its semantics here.

import { describe, expect, test } from "bun:test";
import { hasOverrides } from "../useAppearanceSettings.ts";

describe("hasOverrides", () => {
  test("empty config has no overrides", () => {
    expect(hasOverrides({})).toBe(false);
  });

  test("themeId alone does NOT count as an override", () => {
    // themeId is a named-palette selection, not an override on top of it.
    expect(hasOverrides({ themeId: "dracula" })).toBe(false);
  });

  test("any color override flips the flag", () => {
    expect(hasOverrides({ accent: "#ff0000" })).toBe(true);
    expect(hasOverrides({ background: "#000" })).toBe(true);
    expect(hasOverrides({ foreground: "#fff" })).toBe(true);
  });

  test("any font override flips the flag", () => {
    expect(hasOverrides({ fontUi: "Inter" })).toBe(true);
    expect(hasOverrides({ fontCode: "JetBrains Mono" })).toBe(true);
  });

  test("any sizing override flips the flag", () => {
    expect(hasOverrides({ fontUiSize: 15 })).toBe(true);
    expect(hasOverrides({ fontCodeSize: 12 })).toBe(true);
  });

  test("contrast and translucentSidebar count", () => {
    expect(hasOverrides({ contrast: 60 })).toBe(true);
    expect(hasOverrides({ translucentSidebar: true })).toBe(true);
  });

  test("themeId + override → still true (override is what matters)", () => {
    expect(hasOverrides({ themeId: "dracula", accent: "#ff00ff" })).toBe(true);
  });
});
