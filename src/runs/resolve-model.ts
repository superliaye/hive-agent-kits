// Shared model+provider resolver for the Runs module.
//
// Two duplicated concerns lived in `executor.ts` and `threads/title.ts`:
//   1. the model-tier policy (per-Run override > user's per-agent default >
//      harness config.model > deployment fallback) — ADR-0013, and
//   2. the "provider/model" provider parse.
// Both now route through here. The provider parse reuses the gateway's
// canonical `parseModelProvider` (ADR-0005) rather than a hand-rolled
// `indexOf("/")`.

import { type GatewayFailure, parseModelProvider } from "../model-gateway/index.ts";
import { MODEL_FALLBACK } from "./defaults.ts";

export type ResolveAgentModelInput = {
  /** Agent's harness `config.model`, when set to a string; else undefined. */
  configuredModel: string | undefined;
  /** User's sticky per-agent model default, when set; else undefined. */
  userModelDefault: string | undefined;
  /** Per-Run model override, when present; else undefined. */
  modelOverride?: string;
};

export type ResolveAgentModelResult =
  | { model: string; provider: string }
  | { model: string; failure: GatewayFailure };

// Tier order (ADR-0013): per-Run override > user default > harness config >
// deployment fallback. Provider parsed off the resolved model via the gateway's
// canonical parse — a malformed model surfaces as `failure` for the caller to
// classify (the executor emits `invalid_request`; title-gen silently skips).
export function resolveAgentModel(input: ResolveAgentModelInput): ResolveAgentModelResult {
  const model =
    input.modelOverride ?? input.userModelDefault ?? input.configuredModel ?? MODEL_FALLBACK;
  const parsed = parseModelProvider(model);
  if ("failure" in parsed) return { model, failure: parsed.failure };
  return { model, provider: parsed.provider };
}
