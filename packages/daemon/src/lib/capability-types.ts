// Shared vocabulary for kebab-case identifiers and Agent Backends.
//
// Single source of truth for the kebab-case naming rule and AgentBackend.
// Importers: HTTP wire types, Backends settings, audit query boundary.

import { z } from "zod";

// Lowercase kebab-case identifier; used for Agent ids and provider/name refs
// at the HTTP boundary.
export const KebabName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "must be lowercase kebab-case");

// AgentBackend: the vendor Agent SDK identifier (ADR-0019).
//   claude-code — drives @anthropic-ai/claude-agent-sdk
//   codex       — drives @openai/codex-sdk
export const AgentBackend = z.enum(["claude-code", "codex"]);
export type AgentBackend = z.infer<typeof AgentBackend>;
