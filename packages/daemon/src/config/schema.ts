// The deployment-wide config schema for Hive. Per ADR-0006: single Zod
// schema, nested by domain. Other modules read their slice via `config.watch`.

import { APPEARANCE_DEFAULTS, AppearanceConfigSchema } from "@hive/theming/schema";
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

export const SourcesConfigSchema = z.object({
  workingTreeRoots: z.array(z.string().min(1)),
});

// Runs subtree (ADR-0006 + ADR-0017). `maxIterations` is the tool-loop turn
// cap. Sentinel `0` = UNLIMITED (no cap, no grace turn); a positive integer
// is a finite cap that triggers one grace turn (tools stripped) on overrun.
export const RunsConfigSchema = z.object({
  maxIterations: z.number().int().min(0),
});

// Developer-only escape hatches. `allowRealHomeDeploy` opts a DEV daemon into
// deploying to the user's real ~/.claude etc. instead of the per-instance
// sandbox (the fail-safe default). Off everywhere by default; a packaged build
// deploys real regardless of this toggle (it never reads it).
export const DeveloperConfigSchema = z.object({
  allowRealHomeDeploy: z.boolean(),
});

// Theme/font preferences — what CONTEXT.md calls "UI theme". The appearance
// schema + defaults are owned by `@hive/theming/schema` (ADR-0022); the daemon
// consumes them here and folds them into the deployment-wide config. The strict
// `AppearanceConfigSchema` governs both directions of /api/appearance.
export const AppConfigSchema = z.object({
  audit: AuditConfigSchema,
  ui: UiConfigSchema,
  appearance: AppearanceConfigSchema,
  daemon: DaemonConfigSchema,
  sources: SourcesConfigSchema,
  runs: RunsConfigSchema,
  developer: DeveloperConfigSchema,
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
  appearance: APPEARANCE_DEFAULTS,
  daemon: {
    httpPort: 3117,
    logLevel: "info",
  },
  sources: {
    workingTreeRoots: [],
  },
  runs: {
    // 0 = unlimited. A positive integer caps the tool-loop and adds one grace
    // turn on overrun.
    maxIterations: 0,
  },
  developer: {
    // Fail-safe: a dev deploy lands in the per-instance sandbox unless the user
    // explicitly opts into real-home deploys here.
    allowRealHomeDeploy: false,
  },
};
