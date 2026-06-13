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
import { AgentBackend } from "../lib/capability-types.ts";
import { EFFORT_ORDER, type ThinkingEffort } from "../model-gateway/types.ts";
import { SYMBOLIC_EFFORT_HIGHEST, SYMBOLIC_MODEL_LATEST } from "../runs/symbolic.ts";

// An agent default may be SYMBOLIC (ADR-0015): "latest" model / "highest"
// effort, a rule resolved at Run start rather than a pinned id. So the stored
// value admits the symbolic token OR a concrete value. A concrete model is the
// "provider/model-id" shape (gateway registry is the real validator); a
// concrete effort is an EFFORT_ORDER member.
export const ModelStringSchema = z.union([
  z.literal(SYMBOLIC_MODEL_LATEST),
  z
    .string()
    .min(1)
    .regex(/^[^/]+\/.+$/, "must be 'provider/model-id'"),
]);

// Thinking-effort default — a concrete level (from the canonical EFFORT_ORDER
// tuple, so this can never drift from `ThinkingEffort`) or the symbolic
// "highest".
export const EffortSchema = z.union([z.literal(SYMBOLIC_EFFORT_HIGHEST), z.enum(EFFORT_ORDER)]);
export type Effort = z.infer<typeof EffortSchema>;
// Compile-time guard: a concrete ThinkingEffort is a valid Effort.
const _effortMatches: Effort = "off" satisfies ThinkingEffort;
void _effortMatches;

// The Agent-Backend default (apply-to-default target, ADR-0015). An id ONLY —
// a backend carries no stored config block (the CLI invocation is assembled at
// Run start, ADR-0016). Not symbolic: backend is a concrete discriminator.
export const BackendSchema = AgentBackend;

// A single agent's stored preference. All fields optional and independent; the
// store merges on write so setting one never clobbers the others.
export const AgentPrefSchema = z.object({
  model: ModelStringSchema.optional(),
  effort: EffortSchema.optional(),
  backend: BackendSchema.optional(),
  updatedAt: z.number(),
});
export type AgentPref = z.infer<typeof AgentPrefSchema>;

export const AGENT_PREFS_FILE_VERSION = 1;

export const AgentPrefsFileSchema = z.object({
  version: z.literal(AGENT_PREFS_FILE_VERSION),
  prefs: z.record(z.string(), AgentPrefSchema),
});
export type AgentPrefsFile = z.infer<typeof AgentPrefsFileSchema>;

export type Backend = z.infer<typeof BackendSchema>;

// The patch a `set` accepts. Omitting a field leaves the stored value
// unchanged (merge semantics). `backend: null` clears the stored backend
// default (back to the Harness-authored backend).
export type AgentPrefPatch = { model?: string; effort?: Effort; backend?: Backend | null };

// Events emitted by the module. Audit subscribes via the standard pattern
// (ADR-0004). agentId + model id + effort level + backend id are non-secret
// identifiers — safe in the payload. The event carries whichever fields the
// write touched.
export type AgentPrefEvents = {
  "agent_pref.set": {
    agentId: string;
    model?: string;
    effort?: Effort;
    backend?: Backend;
    // A cleared backend default (patch.backend === null) is named here so it
    // stays distinguishable from a no-touch in audit (mirrors thread.scope_set).
    cleared?: "backend"[];
  };
};

// Public shape for listing (diagnostics / round-trip).
export type ConfiguredAgentPref = {
  agentId: string;
  model?: string;
  effort?: Effort;
  backend?: Backend;
  updatedAt: number;
};
