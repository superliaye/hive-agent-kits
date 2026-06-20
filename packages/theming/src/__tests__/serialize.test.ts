import { describe, expect, test } from "bun:test";
import { AppearanceConfigSchema, APPEARANCE_DEFAULTS } from "../schema.ts";
import {
  exportPreferences,
  exportPreferencesWire,
  importPreferences,
  THEME_WIRE_PREFIX,
} from "../serialize.ts";
import type { Preferences } from "../types.ts";

const sample: Preferences = {
  mode: "dark",
  light: { accent: "#3366ff", fontUiSize: 15 },
  dark: { accent: "#88aaff", contrast: 60, translucentSidebar: true },
  reduceMotion: "on",
  pointerCursors: true,
  useSystemAccent: false,
};

describe("schema", () => {
  test("APPEARANCE_DEFAULTS round-trips through the strict schema", () => {
    expect(AppearanceConfigSchema.parse(APPEARANCE_DEFAULTS)).toEqual(APPEARANCE_DEFAULTS);
  });

  test("a populated sample parses", () => {
    expect(AppearanceConfigSchema.parse(sample)).toEqual(sample);
  });

  test("the strict schema rejects an unknown key (daemon PUT boundary)", () => {
    const withExtra = { ...APPEARANCE_DEFAULTS, surprise: true };
    expect(AppearanceConfigSchema.safeParse(withExtra).success).toBe(false);
  });
});

describe("import/export round-trip", () => {
  test("exported JSON re-imports identically", () => {
    const result = importPreferences(exportPreferences(sample));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preferences).toEqual(sample);
  });

  test("wire (clipboard) form re-imports identically", () => {
    const wire = exportPreferencesWire(sample);
    expect(wire.startsWith(THEME_WIRE_PREFIX)).toBe(true);
    const result = importPreferences(wire);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preferences).toEqual(sample);
  });
});

describe("lenient import (share-with-friends)", () => {
  test("an unknown key is accepted and dropped, not rejected", () => {
    const file = JSON.stringify({
      version: 1,
      preferences: {
        mode: "light",
        light: { accent: "#abc123", futureField: "ignored" },
        dark: {},
        reduceMotion: "system",
        pointerCursors: false,
        useSystemAccent: false,
      },
    });
    const result = importPreferences(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preferences.light.accent).toBe("#abc123");
      expect("futureField" in result.preferences.light).toBe(false);
    }
  });

  test("a file omitting newer top-level fields fills defaults", () => {
    const file = JSON.stringify({ version: 1, preferences: { mode: "dark" } });
    const result = importPreferences(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preferences.reduceMotion).toBe("system");
      expect(result.preferences.pointerCursors).toBe(false);
      expect(result.preferences.light).toEqual({});
    }
  });

  test("an out-of-bounds field is rejected", () => {
    const file = JSON.stringify({
      version: 1,
      preferences: { mode: "light", light: { fontUiSize: 99 }, dark: {} },
    });
    const result = importPreferences(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("preferences");
  });
});
