// Public API for the Backend Readiness projection module.
//
// A per-backend read-model joining an Agent Backend's availability (the probe)
// with the Secret auth state of its mapped provider. Read-only; feeds the
// Settings "Backends" page. Hive detects + projects — it does not manage auth
// flows (ADR-0019).

export type {
  BackendReadinessSvc,
  CreateBackendReadinessOptions,
  ReadinessProbePort,
  ReadinessSecretsPort,
} from "./effect/backend-readiness-live.ts";
export {
  BackendReadinessLive,
  BackendReadinessService,
} from "./effect/backend-readiness-live.ts";
export type { StoredSecretMeta } from "./types.ts";
// `BackendReadiness` is exported as both the Zod schema (value) and its inferred
// type (the Zod single-source-of-truth idiom), so consumers can both
// `.array().parse(...)` and type-annotate with one name.
export { BACKEND_PROVIDER, BackendAuthState, BackendReadiness } from "./types.ts";
