// Agent model-preferences module — types + Zod schemas.
//
// Disk shape (`~/.hive/agent-model-prefs.json`):
//
//   {
//     "version": 1,
//     "prefs": {
//       "agent-manager": { "model": "anthropic/claude-opus-4-7", "updatedAt": 1730000000000 }
//     }
//   }
//
// A per-agent USER preference: the model the user last picked for an Agent's
// conversations. It sits between the per-Run override and the Agent's bundled
// HARNESS.md `config.model` in the executor's resolution chain, so a user's
// pick sticks without rewriting version-controlled bundled Harness files.
// Zod-validated at the disk boundary (AGENTS.md).

import { z } from "zod";

// "provider/model-id" — mirrors StartRunBody.modelOverride; the gateway
// registry is the real validator, this is the boundary sanity-check.
export const ModelStringSchema = z
  .string()
  .min(1)
  .regex(/^[^/]+\/.+$/, "must be 'provider/model-id'");

export const AgentModelPrefSchema = z.object({
  model: ModelStringSchema,
  updatedAt: z.number(),
});
export type AgentModelPref = z.infer<typeof AgentModelPrefSchema>;

export const AGENT_PREFS_FILE_VERSION = 1;

export const AgentPrefsFileSchema = z.object({
  version: z.literal(AGENT_PREFS_FILE_VERSION),
  prefs: z.record(z.string(), AgentModelPrefSchema),
});
export type AgentPrefsFile = z.infer<typeof AgentPrefsFileSchema>;

// Events emitted by the module. Audit subscribes via the standard pattern
// (ADR-0004). agentId + model are non-secret identifiers — safe in the payload.
export type AgentPrefEvents = {
  "agent_model_pref.set": { agentId: string; model: string };
};

// Public shape for listing (diagnostics / round-trip).
export type ConfiguredAgentModelPref = {
  agentId: string;
  model: string;
  updatedAt: number;
};
