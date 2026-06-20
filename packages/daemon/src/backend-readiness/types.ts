// Backend Readiness — daemon-internal pieces. The wire schemas (BackendReadiness,
// BackendAuthState, StoredSecretMeta) live in @hive/contract, where
// BackendReadiness COMPOSES BackendStatus (`.extend()`) so the health fields
// cannot drift from the probe's wire shape. This module keeps the static
// backend → provider map (new domain truth).

import type { ProbeableBackend } from "@hive/contract";

export {
  BackendAuthState,
  BackendReadiness,
  StoredSecretMeta,
} from "@hive/contract";

// Static 1:1 backend → provider map. This is NEW domain truth: no existing
// backend→provider map exists (the executor derives provider from the resolved
// MODEL, not the backend). The 1:1 invariant holds because each vendor SDK only
// handles its own provider's models. The provider key for codex is
// "openai-codex" (the model-catalog provider id), NOT "openai".
export const BACKEND_PROVIDER: Record<ProbeableBackend, string> = {
  "claude-code": "anthropic",
  codex: "openai-codex",
};
