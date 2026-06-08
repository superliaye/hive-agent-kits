// Agent preferences module — types + Zod schemas.
//
// Disk shape (`~/.hive/agent-model-prefs.json`):
//
//   {
//     "version": 1,
//     "prefs": {
//       "agent-manager": {
//         "model": "anthropic/claude-opus-4-7",
//         "effort": "high",
//         "updatedAt": 1730000000000
//       }
//     }
//   }
//
// A per-agent USER preference: the model AND thinking effort the user last
// picked for an Agent's conversations. Each sits between the per-Run override
// and the Agent's bundled HARNESS.md config in the executor's resolution chain,
// so a user's pick sticks without rewriting version-controlled bundled Harness
// files. Both fields are independent and optional — setting one preserves the
// other. Zod-validated at the disk boundary (AGENTS.md).

import { z } from "zod";
import { EFFORT_ORDER, type ThinkingEffort } from "../model-gateway/types.ts";

// "provider/model-id" — mirrors StartRunBody.modelOverride; the gateway
// registry is the real validator, this is the boundary sanity-check.
export const ModelStringSchema = z
  .string()
  .min(1)
  .regex(/^[^/]+\/.+$/, "must be 'provider/model-id'");

// Thinking-effort levels — the boundary validator, inferred from the canonical
// `EFFORT_ORDER` tuple so this enum can never drift from `ThinkingEffort`.
export const EffortSchema = z.enum(EFFORT_ORDER);
export type Effort = z.infer<typeof EffortSchema>;
// Compile-time guard: EffortSchema's members are exactly ThinkingEffort.
const _effortMatches: ThinkingEffort = "off" satisfies Effort;
void _effortMatches;

// A single agent's stored preference. Both fields optional and independent;
// the store merges on write so setting one never clobbers the other.
export const AgentPrefSchema = z.object({
  model: ModelStringSchema.optional(),
  effort: EffortSchema.optional(),
  updatedAt: z.number(),
});
export type AgentPref = z.infer<typeof AgentPrefSchema>;

export const AGENT_PREFS_FILE_VERSION = 1;

export const AgentPrefsFileSchema = z.object({
  version: z.literal(AGENT_PREFS_FILE_VERSION),
  prefs: z.record(z.string(), AgentPrefSchema),
});
export type AgentPrefsFile = z.infer<typeof AgentPrefsFileSchema>;

// The patch a `set` accepts. Omitting a field leaves the stored value
// unchanged (merge semantics).
export type AgentPrefPatch = { model?: string; effort?: Effort };

// Events emitted by the module. Audit subscribes via the standard pattern
// (ADR-0004). agentId + model id + effort level are non-secret identifiers —
// safe in the payload. The event carries whichever fields the write touched.
export type AgentPrefEvents = {
  "agent_pref.set": { agentId: string; model?: string; effort?: Effort };
};

// Public shape for listing (diagnostics / round-trip).
export type ConfiguredAgentPref = {
  agentId: string;
  model?: string;
  effort?: Effort;
  updatedAt: number;
};
