// Appearance schema — the single source of truth for the appearance wire shape.
//
// React-free: imports only `zod`. The daemon consumes this subpath
// (`@hive/theming/schema`) for its /api/appearance boundary; the UI validates
// share-with-friends imports against it. Both sides derive their bounds
// (8..48, 0..100, 1..64, 1..256) from here — defined once.

import { z } from "zod";

const ColorString = z.string().min(1).max(64);
const FontString = z.string().min(1).max(256);

// The per-mode override shape, defined once. Bounds live here.
const themeConfigShape = {
  themeId: z.string().min(1).max(64).optional(),
  accent: ColorString.optional(),
  background: ColorString.optional(),
  foreground: ColorString.optional(),
  fontUi: FontString.optional(),
  fontCode: FontString.optional(),
  fontUiSize: z.number().int().min(8).max(48).optional(),
  fontCodeSize: z.number().int().min(8).max(48).optional(),
  contrast: z.number().min(0).max(100).optional(),
  translucentSidebar: z.boolean().optional(),
} as const;

// `.strict()` is the daemon's PUT boundary contract — unknown keys are rejected.
export const ThemeConfigSchema = z.object(themeConfigShape).strict();

const appearanceShape = {
  mode: z.enum(["light", "dark", "system"]),
  light: ThemeConfigSchema,
  dark: ThemeConfigSchema,
  reduceMotion: z.enum(["system", "on", "off"]),
  pointerCursors: z.boolean(),
  useSystemAccent: z.boolean(),
} as const;

export const AppearanceConfigSchema = z.object(appearanceShape).strict();

// Lenient (key-stripping) variant for share-with-friends import: same bounds,
// but unknown keys are silently dropped rather than rejected — preserving
// forward-compat with files written by a newer theming version. Zod's default
// object behavior strips unknown keys, so no `.strict()`. `reduceMotion`,
// `pointerCursors`, `useSystemAccent` are optional here (an exported file may
// predate them); the importer fills defaults.
const ThemeConfigLenient = z.object(themeConfigShape);

export const AppearanceConfigLenient = z.object({
  mode: z.enum(["light", "dark", "system"]),
  light: ThemeConfigLenient.optional(),
  dark: ThemeConfigLenient.optional(),
  reduceMotion: z.enum(["system", "on", "off"]).optional(),
  pointerCursors: z.boolean().optional(),
  useSystemAccent: z.boolean().optional(),
});

export type ThemeConfig = z.infer<typeof ThemeConfigSchema>;
export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>;

// Default appearance — the empty per-mode configs mean "use the mode's base
// palette". The daemon folds this into APP_CONFIG_DEFAULTS.
export const APPEARANCE_DEFAULTS: AppearanceConfig = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
  useSystemAccent: false,
};
