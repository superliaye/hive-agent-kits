// The tiered resolution seam for a Run: model + thinking-effort + backend.
//
// Seam 2 of the Run-path (F1). `resolve()` composes today's tier policy:
//   - model    : per-Run override > user per-agent default > harness config >
//                deployment fallback (ADR-0013), via `resolveAgentModel`
//                (imported unchanged — `threads/title.ts` calls it directly).
//   - effort   : per-Run override > user per-agent default > harness
//                config.thinkingEffort (type-guarded) > undefined. "No effort
//                fallback" is preserved (ADR-0013): `undefined` means the loop
//                omits the `thinking` block and the provider applies its own
//                default.
//   - backend  : passed straight through from the Agent (ADR-0009).
//
// The SIGNATURE + return shape are the contract Wave-2's selection lane (E)
// hangs off — E later replaces the tier bodies (conversation scope,
// apply-to-default promotion, symbolic "latest"/"highest") WITHOUT touching the
// tool-loop or the backend-dispatch switch. Keep this file the only place those
// tiers live.

import type { AgentBackend } from "../lib/capability-types.ts";
import type { GatewayFailure } from "../model-gateway/effect/failure.ts";
import { EFFORT_ORDER, type ThinkingEffort } from "../model-gateway/types.ts";
import { resolveAgentModel } from "./resolve-model.ts";

export type ResolveInput = {
  /** Agent's harness `config.model`, when a string; else undefined. */
  configuredModel: string | undefined;
  /** Agent's harness `config.thinkingEffort` (raw `unknown` from open config). */
  configuredEffort: unknown;
  /** User's sticky per-agent model default, when set; else undefined. */
  userModelDefault: string | undefined;
  /** User's sticky per-agent effort default, when set; else undefined. */
  userEffortDefault: ThinkingEffort | undefined;
  /** Per-Run model override, when present; else undefined. */
  modelOverride?: string;
  /** Per-Run effort override, when present; else undefined. */
  effortOverride?: ThinkingEffort;
  /** The Agent's backend (native | claude-code | codex). */
  backend: AgentBackend;
};

export type ResolveResult =
  | { model: string; provider: string; effort?: ThinkingEffort; backend: AgentBackend }
  | { model: string; failure: GatewayFailure };

function isThinkingEffort(v: unknown): v is ThinkingEffort {
  return typeof v === "string" && (EFFORT_ORDER as readonly string[]).includes(v);
}

// Narrow an Agent's harness `config.thinkingEffort` (an `unknown` from the open
// config record) to a valid `ThinkingEffort`, or `undefined` if absent / not a
// recognized level — the closed-enum membership check the loop relied on inline.
function configuredEffort(raw: unknown): ThinkingEffort | undefined {
  return isThinkingEffort(raw) ? raw : undefined;
}

export function resolve(input: ResolveInput): ResolveResult {
  const modelResult = resolveAgentModel({
    configuredModel: input.configuredModel,
    userModelDefault: input.userModelDefault,
    ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
  });
  if ("failure" in modelResult) {
    return { model: modelResult.model, failure: modelResult.failure };
  }

  // Effort tier (mirrors model): per-Run override > user default > harness
  // config.thinkingEffort (type-guarded) > undefined (no `thinking` block).
  const effort: ThinkingEffort | undefined =
    input.effortOverride ?? input.userEffortDefault ?? configuredEffort(input.configuredEffort);

  return {
    model: modelResult.model,
    provider: modelResult.provider,
    ...(effort !== undefined ? { effort } : {}),
    backend: input.backend,
  };
}
