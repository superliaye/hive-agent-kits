// Serialize/parse Preferences for share-with-friends. Two surface forms:
//   - File export: plain JSON, downloadable.
//   - Clipboard copy: same JSON prefixed with `codex-theme-v1:` so it can
//     be pasted into any text field and round-tripped.
//
// importPreferences accepts both forms (strips the prefix if present).
// Validation is structural only — color/font strings pass through.

import type { Preferences, ThemeConfig } from "./types.ts";

export const THEME_WIRE_PREFIX = "codex-theme-v1:";
export const PREFERENCES_FILE_VERSION = 1;

export type PreferencesFile = {
  version: 1;
  preferences: Preferences;
};

/** JSON-only form for file download. */
export function exportPreferences(prefs: Preferences): string {
  const out: PreferencesFile = {
    version: PREFERENCES_FILE_VERSION,
    preferences: prefs,
  };
  return JSON.stringify(out, null, 2);
}

/** Wire form for clipboard copy/paste (single line, prefix-tagged). */
export function exportPreferencesWire(prefs: Preferences): string {
  const out: PreferencesFile = {
    version: PREFERENCES_FILE_VERSION,
    preferences: prefs,
  };
  return `${THEME_WIRE_PREFIX}${JSON.stringify(out)}`;
}

export type ImportResult = { ok: true; preferences: Preferences } | { ok: false; error: string };

export function importPreferences(text: string): ImportResult {
  let json = text.trim();
  if (json.startsWith(THEME_WIRE_PREFIX)) json = json.slice(THEME_WIRE_PREFIX.length).trim();

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "expected an object at the top level" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== PREFERENCES_FILE_VERSION) {
    return { ok: false, error: `unsupported file version: ${String(obj.version)}` };
  }
  const prefs = obj.preferences;
  if (!prefs || typeof prefs !== "object") {
    return { ok: false, error: "missing `preferences` object" };
  }
  const p = prefs as Record<string, unknown>;

  if (p.mode !== "light" && p.mode !== "dark" && p.mode !== "system") {
    return { ok: false, error: 'preferences.mode must be "light" | "dark" | "system"' };
  }

  const light = parseConfig(p.light, "light");
  if ("error" in light) return { ok: false, error: light.error };
  const dark = parseConfig(p.dark, "dark");
  if ("error" in dark) return { ok: false, error: dark.error };

  if (
    p.reduceMotion !== undefined &&
    p.reduceMotion !== "system" &&
    p.reduceMotion !== "on" &&
    p.reduceMotion !== "off"
  ) {
    return { ok: false, error: 'preferences.reduceMotion must be "system" | "on" | "off"' };
  }
  if (p.pointerCursors !== undefined && typeof p.pointerCursors !== "boolean") {
    return { ok: false, error: "preferences.pointerCursors must be a boolean" };
  }

  // After the guards above, TS narrows p.reduceMotion to the literal
  // union and p.pointerCursors to boolean | undefined. No casts needed.
  return {
    ok: true,
    preferences: {
      mode: p.mode,
      light: light.config,
      dark: dark.config,
      reduceMotion: p.reduceMotion ?? "system",
      pointerCursors: p.pointerCursors ?? false,
    },
  };
}

function parseConfig(value: unknown, key: string): { config: ThemeConfig } | { error: string } {
  if (value === undefined) return { config: {} };
  if (!value || typeof value !== "object") {
    return { error: `preferences.${key} must be an object` };
  }
  const c = value as Record<string, unknown>;
  const out: ThemeConfig = {};
  for (const k of ["themeId", "accent", "background", "foreground", "fontUi", "fontCode"] as const) {
    const v = c[k];
    if (v === undefined) continue;
    if (typeof v !== "string") return { error: `preferences.${key}.${k} must be a string` };
    out[k] = v;
  }
  for (const k of ["fontUiSize", "fontCodeSize", "contrast"] as const) {
    const v = c[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { error: `preferences.${key}.${k} must be a number` };
    }
    out[k] = v;
  }
  if (c.translucentSidebar !== undefined) {
    if (typeof c.translucentSidebar !== "boolean") {
      return { error: `preferences.${key}.translucentSidebar must be a boolean` };
    }
    out.translucentSidebar = c.translucentSidebar;
  }
  return { config: out };
}
