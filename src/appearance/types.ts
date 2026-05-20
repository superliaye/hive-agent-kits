// Appearance module — types + Zod schemas for the user's theme + font
// preferences. Persisted to `~/.hive/appearance.json` so the UI's theme
// survives daemon restarts. Mirrors the Secrets module's shape: store +
// persistence + events, narrow public Interface.
//
// The shape is intentionally a thin wire mirror of the theming module's
// `Preferences` type (UI side). We hand-mirror — the theming module is
// portable and has no Zod dependency; the daemon owns the HTTP-boundary
// validation per AGENTS.md.

import { z } from "zod";

export const APPEARANCE_FILE_VERSION = 1;

// Free-form hex / named-color string at the wire — value validation is
// the theming module's job on read. The daemon just guards shape.
const ColorString = z.string().min(1).max(64);

const OverridesSchema = z
  .object({
    accent: ColorString.optional(),
    background: ColorString.optional(),
    foreground: ColorString.optional(),
  })
  .strict();

const FontsSchema = z
  .object({
    ui: z.string().min(1).max(256).optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();

export const PreferencesSchema = z
  .object({
    // Built-in preset id ("light" | "dark" | "dim" | "high-contrast") OR
    // "system" to follow the OS preference. Stored as a string so future
    // presets are additive at the wire.
    presetId: z.string().min(1).max(64),
    overrides: OverridesSchema.optional(),
    fonts: FontsSchema.optional(),
  })
  .strict();

export type Preferences = z.infer<typeof PreferencesSchema>;

export const AppearanceFileSchema = z.object({
  version: z.literal(APPEARANCE_FILE_VERSION),
  preferences: PreferencesSchema,
});

export type AppearanceFile = z.infer<typeof AppearanceFileSchema>;

// Default preferences when no file exists yet. System-follow is the
// expected first-launch behavior per ADR-0006's reactive-defaults pattern.
export const DEFAULT_PREFERENCES: Preferences = {
  presetId: "system",
};

// Events emitted by the Appearance module. Audit subscribes via the
// standard pattern (ADR-0004). Payloads carry the preset id but never
// the full preferences object — the audit log shouldn't replay user-
// chosen colors verbatim.
export type AppearanceEvents = {
  "appearance.read": { presetId: string };
  "appearance.changed": { presetId: string };
};
