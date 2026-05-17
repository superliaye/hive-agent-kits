// Per-kind Zod schemas for Capability manifests and Agent Harnesses,
// per ADR-0007. The Registry/Catalog will import these once the runtime
// loader lands; today only the bundled-schema test imports them, which
// is enough to prevent silent regressions in the bundled set.
//
// Each per-kind schema is .strict() — unknown frontmatter keys are
// load-time errors.

import { z } from "zod";
import { AgentBackend, KebabName } from "../lib/capability-types.ts";

// Source pin recorded on vendored capabilities (see ADR-0007).
// `url` is rendered in the UI and used as a grouping key; constrained to a
// sensible upper bound and to URL shape so a malformed manifest can't bloat
// the UI or inject path-like garbage that flows into slug-based grouping.
export const Source = z
  .object({
    url: z
      .string()
      .min(1)
      .max(512)
      .regex(/^(?:https?:\/\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/, "must be a repo-style url (host/owner/repo)"),
    ref: z.string().min(1).max(128),
    fetchedAt: z.string().min(1).max(64),
  })
  .strict();
export type Source = z.infer<typeof Source>;

// System-side compatibility checked at Run-start / server-start.
export const Compatibility = z
  .object({
    model: z.array(z.string()).optional(),
    system: z
      .object({
        binaries: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        services: z.array(z.string()).optional(),
        platforms: z.array(z.enum(["win32", "darwin", "linux"])).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Compatibility = z.infer<typeof Compatibility>;

const Description = z.string().min(1).max(2048);

export const SkillManifest = z
  .object({
    name: KebabName,
    description: Description,
    tags: z.array(z.string()).optional(),
    source: Source.optional(),
    manualInvocationOnly: z.boolean().optional(),
    allowedTools: z.array(z.string()).optional(),
    argumentHint: z.string().optional(),
    compatibility: Compatibility.optional(),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifest>;

export const SnippetManifest = z
  .object({
    name: KebabName,
    description: Description,
    tags: z.array(z.string()).optional(),
    source: Source.optional(),
  })
  .strict();
export type SnippetManifest = z.infer<typeof SnippetManifest>;

export const McpManifest = z
  .object({
    name: KebabName,
    description: Description,
    title: z.string().optional(),
    transport: z.enum(["stdio", "http"]),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    compatibility: Compatibility.optional(),
  })
  .strict();
export type McpManifest = z.infer<typeof McpManifest>;

export const HarnessManifest = z
  .object({
    agentId: KebabName,
    backend: AgentBackend,
    domain: z.string().min(1),
    bindings: z
      .object({
        skills: z.array(z.string()).default([]),
        snippets: z.array(z.string()).default([]),
        tools: z.array(z.string()).default([]),
        mcp: z.array(z.string()).default([]),
      })
      .strict(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type HarnessManifest = z.infer<typeof HarnessManifest>;
