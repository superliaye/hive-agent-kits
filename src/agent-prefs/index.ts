// Public API for the agent model-preferences module.
//
// A small persisted store keyed by agentId holding the user's chosen model
// default per Agent. It is the USER-preference tier in the executor's model
// resolution: per-Run override → this → harness config.model → MODEL_FALLBACK
// (the bundled HARNESS.md is never rewritten). Implementation is Effect-native
// (`AgentModelPrefsLive`); consumers resolve the service off the root runtime.

export type {
  AgentModelPrefsSvc,
  CreateAgentPrefsOptions,
} from "./effect/agent-prefs-live.ts";
export { AgentModelPrefs, AgentModelPrefsLive } from "./effect/agent-prefs-live.ts";
export type {
  AgentModelPref,
  AgentPrefEvents,
  ConfiguredAgentModelPref,
} from "./types.ts";
