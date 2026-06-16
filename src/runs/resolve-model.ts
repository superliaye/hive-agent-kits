// Shared model+provider resolver for the Runs module.
//
// Two duplicated concerns lived in `executor.ts` and `threads/title.ts`:
//   1. the model-tier policy (per-Run override > user's per-agent default >
//      harness config.model > deployment fallback) — ADR-0013, and
//   2. the "provider/model" provider parse.
// Both now route through here. The provider parse reuses the model-catalog's
// canonical `parseModelProvider` rather than a hand-rolled `indexOf("/")`.

import type { ThinkingEffort } from "../lib/effort.ts";
import { BackendFailure } from "./backends/stream-events.ts";
import { MODEL_FALLBACK } from "./defaults.ts";
import { parseModelProvider } from "./model-catalog.ts";
import { isSymbolicModel, type RunnableCatalog, resolveLatestModel } from "./symbolic.ts";

export type ResolveAgentModelInput = {
  /** Agent's harness `config.model`, when set to a string; else undefined. */
  configuredModel: string | undefined;
  /** User's sticky per-agent model default, when set; else undefined. */
  userModelDefault: string | undefined;
  /** Thread-scope model pick, when set; else undefined. Symbolic allowed. */
  threadModel?: string;
  /** Per-Run model override, when present; else undefined. Always concrete. */
  modelOverride?: string;
  /**
   * Runnable model catalog (credentialed ∩ routable, newest-first) — the data a
   * symbolic "latest" default resolves against. Absent on call sites that never
   * see a symbolic value (a symbolic winner then surfaces as a failure).
   */
  runnableCatalog?: RunnableCatalog;
};

export type ResolveAgentModelResult =
  | { model: string; provider: string; efforts?: readonly ThinkingEffort[] }
  | { model: string; failure: BackendFailure };

// Tier order (ADR-0013, +ADR-0015 Thread scope): per-Run override > Thread scope
// > user default > harness config > deployment fallback. A SYMBOLIC winner
// ("latest") is resolved against the runnable catalog BEFORE the provider parse,
// so the concrete result is guaranteed credentialed+routable. Provider parsed
// off the resolved model via the model-catalog's canonical parse — a malformed model
// surfaces as `failure` for the caller to classify (the executor emits
// `invalid_request`; title-gen silently skips). `efforts` (when a symbolic model
// resolved) carries the resolved model's supported levels for "highest".
export function resolveAgentModel(input: ResolveAgentModelInput): ResolveAgentModelResult {
  const winner =
    input.modelOverride ??
    input.threadModel ??
    input.userModelDefault ??
    input.configuredModel ??
    MODEL_FALLBACK;

  if (isSymbolicModel(winner)) {
    const latest = resolveLatestModel(input.runnableCatalog ?? { models: [] });
    if (!latest) {
      return {
        model: winner,
        failure: new BackendFailure({
          code: "model_not_found",
          message:
            'symbolic model "latest" has no runnable model to resolve to — no credentialed, routable provider is configured',
        }),
      };
    }
    return { model: latest.model, provider: latest.provider, efforts: latest.efforts };
  }

  const parsed = parseModelProvider(winner);
  if ("failure" in parsed) return { model: winner, failure: parsed.failure };
  return { model: winner, provider: parsed.provider };
}
