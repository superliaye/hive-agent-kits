// Pure-function coverage for the AppearanceSettings orchestration hook.
// The full hook needs a React tree to test (no React Testing Library
// in this project) — but `hasOverrides` is the load-bearing predicate
// that drives the "Modified" badge and the "Reset overrides" link, so
// pin its semantics here.

import { describe, expect, test } from "bun:test";
import { displayedAccent, hasOverrides } from "../useAppearanceSettings.ts";

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

describe("displayedAccent", () => {
  test("locked → shows the applied (effective) accent, not the per-mode override", () => {
    // System accent on: the OS accent is what the app renders; the dormant
    // per-mode override must NOT be displayed.
    expect(
      displayedAccent({
        locked: true,
        overrideAccent: "#ff0000",
        effectiveAccent: "#0a84ff",
      }),
    ).toBe("#0a84ff");
  });

  test("locked but no effective accent → empty string (palette fallback in UI)", () => {
    expect(
      displayedAccent({ locked: true, overrideAccent: "#ff0000", effectiveAccent: undefined }),
    ).toBe("");
  });

  test("unlocked → shows the per-mode override", () => {
    expect(
      displayedAccent({
        locked: false,
        overrideAccent: "#ff0000",
        effectiveAccent: "#0a84ff",
      }),
    ).toBe("#ff0000");
  });

  test("unlocked with no override → empty string (palette fallback in UI)", () => {
    expect(
      displayedAccent({ locked: false, overrideAccent: undefined, effectiveAccent: "#0a84ff" }),
    ).toBe("");
  });
});
