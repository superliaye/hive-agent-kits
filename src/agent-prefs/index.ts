// Public API for the agent preferences module.
//
// A small persisted store keyed by agentId holding the user's chosen model AND
// thinking-effort defaults per Agent. Each is the USER-preference tier in the
// executor's resolution: per-Run override → this → harness config → fallback
// (the bundled HARNESS.md is never rewritten). Implementation is Effect-native
// (`AgentModelPrefsLive`); consumers resolve the service off the root runtime.

export type {
  AgentModelPrefsSvc,
  CreateAgentPrefsOptions,
} from "./effect/agent-prefs-live.ts";
export { AgentModelPrefs, AgentModelPrefsLive } from "./effect/agent-prefs-live.ts";
export type {
  AgentPref,
  AgentPrefEvents,
  AgentPrefPatch,
  ConfiguredAgentPref,
  Effort,
} from "./types.ts";
