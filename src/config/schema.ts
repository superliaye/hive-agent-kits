// The deployment-wide config schema for Hive. Per ADR-0006: single Zod
// schema, nested by domain. Other modules read their slice via `config.watch`.

import { z } from "zod";

export const AuditRetentionSchema = z.object({
  autoRotate: z.boolean(),
  days: z.number().int().positive(),
  archiveTo: z.enum(["rotate", "delete"]),
});

export const AuditConfigSchema = z.object({
  retention: AuditRetentionSchema,
});

export const UiConfigSchema = z.object({
  language: z.string().min(1),
});

export const DaemonConfigSchema = z.object({
  httpPort: z.number().int().positive(),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});

// Runs subtree (ADR-0006 + ADR-0017). `maxIterations` is the tool-loop turn
// cap. Sentinel `0` = UNLIMITED (no cap, no grace turn); a positive integer
// is a finite cap that triggers one grace turn (tools stripped) on overrun.
export const RunsConfigSchema = z.object({
  maxIterations: z.number().int().min(0),
});

// Theme/font preferences — what CONTEXT.md calls "UI theme". A single
// nested subtree under the top-level `appearance` key. Per-mode configs
// persist independently (the user can customize Light and Dark without
// either clobbering the other).
const ColorString = z.string().min(1).max(64);
const FontString = z.string().min(1).max(256);

export const ThemeConfigSchema = z
  .object({
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
  })
  .strict();

export const AppearanceConfigSchema = z
  .object({
    mode: z.enum(["light", "dark", "system"]),
    light: ThemeConfigSchema,
    dark: ThemeConfigSchema,
    reduceMotion: z.enum(["system", "on", "off"]),
    pointerCursors: z.boolean(),
    useSystemAccent: z.boolean(),
  })
  .strict();

export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>;
export type ThemeConfig = z.infer<typeof ThemeConfigSchema>;

export const AppConfigSchema = z.object({
  audit: AuditConfigSchema,
  ui: UiConfigSchema,
  appearance: AppearanceConfigSchema,
  daemon: DaemonConfigSchema,
  runs: RunsConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// Single source of truth for defaults — merged into user-provided values at
// file load. Adding a new field requires adding both schema entry and default.
export const APP_CONFIG_DEFAULTS: AppConfig = {
  audit: {
    retention: {
      autoRotate: false,
      days: 90,
      archiveTo: "rotate",
    },
  },
  ui: {
    language: "en",
  },
  appearance: {
    mode: "system",
    light: {},
    dark: {},
    reduceMotion: "system",
    pointerCursors: false,
    useSystemAccent: false,
  },
  daemon: {
    httpPort: 3117,
    logLevel: "info",
  },
  runs: {
    // 0 = unlimited (Q5 resolution: default-unlimited). A positive integer
    // caps the tool-loop and adds one grace turn on overrun.
    maxIterations: 0,
  },
};
