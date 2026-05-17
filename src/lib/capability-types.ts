// Shared vocabulary for Capabilities and Agents.
//
// Single source of truth for Origin, CapabilityKind, CapabilityLayer,
// CapabilitySource, AgentBackend, and the kebab-case naming rule.
// Importers: Capability Registry, Agent Catalog, Run module, audit
// wiring, tests. Anything that mentions these terms imports from here.
//
// See CONTEXT.md and docs/adr/0007-capability-lifecycle-and-storage.md.

import { z } from "zod";

// Lowercase kebab-case identifier; used for Capability names AND Agent ids
// (Agent ids share the same shape: see CONTEXT.md "Agent Harness").
export const KebabName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "must be lowercase kebab-case");

export type CapabilityName = z.infer<typeof KebabName>;
export type AgentId = z.infer<typeof KebabName>;

// Origin: how a Capability is classified for portability.
//   personal  — travels with the user across deployments
//   workplace — bound to a specific company; does not travel
export const Origin = z.enum(["personal", "workplace"]);
export type Origin = z.infer<typeof Origin>;

// CapabilityKind: the four Capability kinds per ADR-0007.
// Agent Harness is NOT a Capability — it's an Agent Catalog artifact.
export const CapabilityKind = z.enum(["skill", "snippet", "tool", "mcp"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

// CapabilityLayer: where the Capability is resolved from.
//   bundled — in the Hive repo (committed; immutable at runtime)
//   runtime — in the OS app-storage dir (mutable per install)
// Runtime shadows bundled when both have the same name.
export const CapabilityLayer = z.enum(["runtime", "bundled"]);
export type CapabilityLayer = z.infer<typeof CapabilityLayer>;

// CapabilitySource: how the Capability got into the Registry.
//   filesystem     — scanned from a bundled or runtime folder (Skill/Snippet/MCP)
//   builtin        — registered in TypeScript at daemon startup (built-in Tool)
//   mcp-discovered — surfaced by a running MCP server's tools/list response
export const CapabilitySource = z.enum(["filesystem", "builtin", "mcp-discovered"]);
export type CapabilitySource = z.infer<typeof CapabilitySource>;

// AgentBackend: the runtime that executes a Run for a given Agent.
//   native      — Hive's in-process tool-use loop (uses ModelGateway)
//   claude-code — Hive spawns the Claude Code CLI as a subprocess
//   codex       — Hive spawns the OpenAI Codex CLI as a subprocess
export const AgentBackend = z.enum(["native", "claude-code", "codex"]);
export type AgentBackend = z.infer<typeof AgentBackend>;
