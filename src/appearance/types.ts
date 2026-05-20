// Appearance module — types + Zod schemas for the user's theme + font
// preferences. Persisted to `~/.hive/appearance.json` so the UI's theme
// survives daemon restarts.
//
// The shape mirrors the UI's portable theming module Preferences type.
// We hand-mirror — the theming module is portable and has no Zod
// dependency; the daemon owns HTTP-boundary validation per AGENTS.md.

import { z } from "zod";

export const APPEARANCE_FILE_VERSION = 1;

const ColorString = z.string().min(1).max(64);
const FontString = z.string().min(1).max(256);

const ThemeConfigSchema = z
  .object({
    accent: ColorString.optional(),
    background: ColorString.optional(),
    foreground: ColorString.optional(),
    fontUi: FontString.optional(),
    fontCode: FontString.optional(),
    fontUiSize: z.number().int().min(8).max(48).optional(),
    fontCodeSize: z.number().int().min(8).max(48).optional(),
    contrast: z.number().min(0).max(100).optional(),
    translucentSidebar: z.boolean().optional(),
  })
  .strict();

export const PreferencesSchema = z
  .object({
    mode: z.enum(["light", "dark", "system"]),
    light: ThemeConfigSchema,
    dark: ThemeConfigSchema,
    reduceMotion: z.enum(["system", "on", "off"]),
    pointerCursors: z.boolean(),
  })
  .strict();

export type Preferences = z.infer<typeof PreferencesSchema>;
export type ThemeConfig = z.infer<typeof ThemeConfigSchema>;

export const AppearanceFileSchema = z.object({
  version: z.literal(APPEARANCE_FILE_VERSION),
  preferences: PreferencesSchema,
});

export type AppearanceFile = z.infer<typeof AppearanceFileSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
};

// Audit payloads carry only the mode picker (which is non-sensitive
// taste signal). Color values + per-mode configs stay out of the log.
export type AppearanceEvents = {
  "appearance.read": { mode: Preferences["mode"] };
  "appearance.changed": { mode: Preferences["mode"] };
};
