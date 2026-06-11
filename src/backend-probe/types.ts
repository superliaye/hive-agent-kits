// Backend availability probe types (ADR-0016 "detect, don't manage").
//
// Zod enums are the single source of truth; reason codes are stable string
// literals (the doctor pattern) so the picker/settings can switch on them.

import { z } from "zod";

// The CLI-driven Agent Backends a probe can target. The third AgentBackend
// kind, `native`, is in-process and has nothing to detect.
export const ProbeableBackend = z.enum(["claude-code", "codex"]);
export type ProbeableBackend = z.infer<typeof ProbeableBackend>;

export const PROBEABLE_BACKENDS: readonly ProbeableBackend[] = ProbeableBackend.options;

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

// Wire-stable, JSON-serializable status for one backend. Carries refs only
// (backend id, reason code, version string) — never stderr/paths.
export const BackendStatus = z.object({
  backend: ProbeableBackend,
  installed: z.boolean(),
  version: z.string().nullable(),
  reason: ProbeReasonCode,
  // Milliseconds since epoch when this probe ran.
  checkedAt: z.number(),
});
export type BackendStatus = z.infer<typeof BackendStatus>;
