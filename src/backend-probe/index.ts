// Public API for the backend availability probe module.
//
// Detects which CLI-driven Agent Backends (`claude-code`, `codex`) are
// installed and their versions, with stable reason codes (ADR-0016). Runs at
// daemon startup and on demand; results are exposed over the daemon HTTP
// surface for the picker/settings. Hive detects, it does not manage installs.

export type {
  BackendProbeSvc,
  CreateBackendProbeOptions,
} from "./effect/backend-probe-live.ts";
export { BackendProbe, BackendProbeLive } from "./effect/backend-probe-live.ts";
export type { UpdateResult } from "./probe.ts";
export { notInstalledRunner } from "./probe.ts";
export type { BackendUpdateEvents } from "./types.ts";
export {
  BackendStatus,
  PROBEABLE_BACKENDS,
  ProbeableBackend,
  ProbeReasonCode,
} from "./types.ts";
