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
  theme: z.enum(["light", "dark", "auto"]),
  language: z.string().min(1),
});

export const DaemonConfigSchema = z.object({
  httpPort: z.number().int().positive(),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});

export const AppConfigSchema = z.object({
  audit: AuditConfigSchema,
  ui: UiConfigSchema,
  daemon: DaemonConfigSchema,
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
    theme: "auto",
    language: "en",
  },
  daemon: {
    httpPort: 3117,
    logLevel: "info",
  },
};
