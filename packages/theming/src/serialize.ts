// Serialize/parse Preferences for share-with-friends. Two surface forms:
//   - File export: plain JSON, downloadable.
//   - Clipboard copy: same JSON prefixed with `codex-theme-v1:` so it can
//     be pasted into any text field and round-tripped.
//
// importPreferences accepts both forms (strips the prefix if present). Import is
// validated against `AppearanceConfigLenient` from ./schema.ts — the same bounds
// the daemon enforces, but key-stripping: unknown keys are dropped (forward
// compatibility with files written by a newer theming version), and out-of-bounds
// values are rejected. The daemon's strict `.strict()` schema governs the wire
// PUT only; this share path is deliberately lenient.

import { AppearanceConfigLenient } from "./schema.ts";
import type { Preferences } from "./types.ts";

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

  const parsed = AppearanceConfigLenient.safeParse(obj.preferences);
  if (!parsed.success) {
    return { ok: false, error: formatIssue(parsed.error) };
  }
  const p = parsed.data;

  // Lenient parse leaves the per-mode configs + accessibility toggles optional
  // (an exported file may predate a field); fill defaults to a full Preferences.
  return {
    ok: true,
    preferences: {
      mode: p.mode,
      light: p.light ?? {},
      dark: p.dark ?? {},
      reduceMotion: p.reduceMotion ?? "system",
      pointerCursors: p.pointerCursors ?? false,
      useSystemAccent: p.useSystemAccent ?? false,
    },
  };
}

// Map the first Zod issue to a `preferences.<path>: <message>` string for the
// ImportResult.error field — the existing UI surface for an import failure.
function formatIssue(error: import("zod").ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid preferences";
  const path = ["preferences", ...issue.path].join(".");
  return `${path}: ${issue.message}`;
}
