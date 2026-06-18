// Backend Readiness — a per-backend projection joining an Agent Backend's
// availability (the probe) with the Secret auth state of its mapped provider.
//
// Zod schemas are the single source of truth (the wire shape the Settings page
// reads). BackendReadiness COMPOSES BackendStatus (extends it) so the health
// fields cannot drift from the probe's wire shape.

import { z } from "zod";
import { BackendStatus, type ProbeableBackend } from "../backend-probe/types.ts";

// Static 1:1 backend → provider map. This is NEW domain truth: no existing
// backend→provider map exists (the executor derives provider from the resolved
// MODEL, not the backend). The 1:1 invariant holds because each vendor SDK only
// handles its own provider's models. The provider key for codex is
// "openai-codex" (the model-catalog provider id), NOT "openai".
export const BACKEND_PROVIDER: Record<ProbeableBackend, string> = {
  "claude-code": "anthropic",
  codex: "openai-codex",
};

// What actually authenticates a run:
//   api-key      — Hive injects a stored API key into the run (operative).
//   cli-managed  — the run falls back to the CLI's ambient login. Covers BOTH
//                  no stored secret AND a stored OAuth token (which the adapters
//                  fetch but ignore — only kind==="apiKey" is injected).
export const BackendAuthState = z.enum(["api-key", "cli-managed"]);
export type BackendAuthState = z.infer<typeof BackendAuthState>;

// Metadata about a Hive-stored Secret for this backend's provider, when one
// exists. Lets the UI show what is stored and offer Remove — independent of
// whether it is operative for runs.
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
