// JSON export/import for Preferences. Used by the Settings UI to
// download/upload theme files so users can share with friends.
//
// Schema is intentionally explicit + versioned so a v2 export can
// migrate v1 inputs forward without ambiguity. The validator is hand-
// written — the theming module has no Zod dependency.

import type { Preferences } from "./types.ts";

export const PREFERENCES_FILE_VERSION = 1;

export type PreferencesFile = {
  version: 1;
  preferences: Preferences;
};

/**
 * Serialize current preferences to a JSON string suitable for download.
 * The result includes a `version` field for forward compatibility.
 */
export function exportPreferences(prefs: Preferences): string {
  const out: PreferencesFile = {
    version: PREFERENCES_FILE_VERSION,
    preferences: prefs,
  };
  return JSON.stringify(out, null, 2);
}

export type ImportResult = { ok: true; preferences: Preferences } | { ok: false; error: string };

/**
 * Parse + structurally validate a JSON string. No throws; returns a
 * tagged result so the caller can render a friendly error inline.
 *
 * Validation is structural only — color strings and font stacks are
 * passed through. Bad colors render as the browser's invalid-color
 * fallback (transparent / black); that's acceptable as a user-facing
 * "you imported a broken theme" signal.
 */
export function importPreferences(json: string): ImportResult {
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
  if (typeof p.presetId !== "string" || p.presetId.length === 0) {
    return { ok: false, error: "preferences.presetId must be a non-empty string" };
  }
  const out: Preferences = { presetId: p.presetId };

  if (p.overrides !== undefined) {
    if (!p.overrides || typeof p.overrides !== "object") {
      return { ok: false, error: "preferences.overrides must be an object" };
    }
    const ov = p.overrides as Record<string, unknown>;
    const cleaned: Preferences["overrides"] = {};
    if (ov.accent !== undefined) {
      if (typeof ov.accent !== "string")
        return { ok: false, error: "overrides.accent must be a string" };
      cleaned.accent = ov.accent;
    }
    if (ov.background !== undefined) {
      if (typeof ov.background !== "string")
        return { ok: false, error: "overrides.background must be a string" };
      cleaned.background = ov.background;
    }
    if (ov.foreground !== undefined) {
      if (typeof ov.foreground !== "string")
        return { ok: false, error: "overrides.foreground must be a string" };
      cleaned.foreground = ov.foreground;
    }
    if (Object.keys(cleaned).length > 0) out.overrides = cleaned;
  }

  if (p.fonts !== undefined) {
    if (!p.fonts || typeof p.fonts !== "object") {
      return { ok: false, error: "preferences.fonts must be an object" };
    }
    const f = p.fonts as Record<string, unknown>;
    const cleaned: Preferences["fonts"] = {};
    if (f.ui !== undefined) {
      if (typeof f.ui !== "string") return { ok: false, error: "fonts.ui must be a string" };
      cleaned.ui = f.ui;
    }
    if (f.code !== undefined) {
      if (typeof f.code !== "string") return { ok: false, error: "fonts.code must be a string" };
      cleaned.code = f.code;
    }
    if (Object.keys(cleaned).length > 0) out.fonts = cleaned;
  }

  return { ok: true, preferences: out };
}
