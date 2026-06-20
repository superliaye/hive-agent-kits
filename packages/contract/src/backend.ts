// Backend wire contract — the daemon↔UI types for backend availability +
// readiness (GET /api/backends, /api/backends/readiness). Zod schemas with
// `z.infer`; imports only `zod`. Daemon-internal pieces (the provider map, the
// PROBEABLE_BACKENDS list, the audit emitter, AgentBackend) stay daemon-side.

import { z } from "zod";

// The CLI-driven Agent Backends a probe can target. Distinct from the
// daemon-internal `AgentBackend` enum (same values, separate domain — may
// diverge); kept apart deliberately.
export const ProbeableBackend = z.enum(["claude-code", "codex"]);
export type ProbeableBackend = z.infer<typeof ProbeableBackend>;

// Stable reason codes for a probe outcome:
//   ok                 — on PATH, --version ran cleanly, a version was parsed
//   not_installed      — binary not found on PATH (a normal state, not an error)
//   probe_failed       — binary present but --version exited non-zero
//   version_unreadable — binary present, ran cleanly, but no version in output
//   timeout            — --version did not return within the time budget
export const ProbeReasonCode = z.enum([
  "ok",
  "not_installed",
  "probe_failed",
  "version_unreadable",
  "timeout",
]);
export type ProbeReasonCode = z.infer<typeof ProbeReasonCode>;

// Wire-stable status for one backend. Carries refs only (backend id, reason
// code, version string) — never stderr/paths.
export const BackendStatus = z.object({
  backend: ProbeableBackend,
  installed: z.boolean(),
  version: z.string().nullable(),
  reason: ProbeReasonCode,
  // Milliseconds since epoch when this probe ran.
  checkedAt: z.number(),
});
export type BackendStatus = z.infer<typeof BackendStatus>;

// What actually authenticates a run:
//   api-key      — Hive injects a stored API key into the run (operative).
//   cli-managed  — the run falls back to the CLI's ambient login.
export const BackendAuthState = z.enum(["api-key", "cli-managed"]);
export type BackendAuthState = z.infer<typeof BackendAuthState>;

// Metadata about a Hive-stored Secret for this backend's provider, when one
// exists. Lets the UI show what is stored and offer Remove.
export const StoredSecretMeta = z.object({
  kind: z.enum(["apiKey", "oauth"]),
  status: z.enum(["ok", "expired"]),
  addedAt: z.number(),
  refreshedAt: z.number().optional(),
});
export type StoredSecretMeta = z.infer<typeof StoredSecretMeta>;

// One backend's readiness: the probe's health fields (extended from
// BackendStatus, never redeclared) plus the mapped provider and its auth state.
export const BackendReadiness = BackendStatus.extend({
  provider: z.string(),
  auth: z.object({
    state: BackendAuthState,
    stored: StoredSecretMeta.optional(),
  }),
});
export type BackendReadiness = z.infer<typeof BackendReadiness>;
