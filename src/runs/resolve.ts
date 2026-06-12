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
//   - backend  : Thread-scope pick > user per-agent default > harness-authored
//                backend (ADR-0015). No per-Run backend override / symbolic
//                backend — a concrete discriminator.
//
// The SIGNATURE + return shape are the contract Wave-2's selection lane (E)
// hangs off — E later replaces the tier bodies (conversation scope,
// apply-to-default promotion, symbolic "latest"/"highest") WITHOUT touching the
// tool-loop or the backend-dispatch switch. Keep this file the only place those
// tiers live.

import type { AgentBackend } from "../lib/capability-types.ts";
import type { GatewayFailure } from "../model-gateway/effect/failure.ts";
import type { ThinkingEffort } from "../model-gateway/types.ts";
import { resolveAgentModel } from "./resolve-model.ts";
import {
  type EffortDefault,
  isSymbolicEffort,
  isThinkingEffort,
  type RunnableCatalog,
  resolveHighestEffort,
} from "./symbolic.ts";

export type ResolveInput = {
  /** Agent's harness `config.model`, when a string; else undefined. */
  configuredModel: string | undefined;
  /** Agent's harness `config.thinkingEffort` (raw `unknown` from open config). */
  configuredEffort: unknown;
  /** User's sticky per-agent model default, when set; else undefined. */
  userModelDefault: string | undefined;
  /** User's sticky per-agent effort default, when set; else undefined. */
  userEffortDefault: EffortDefault | undefined;
  /** Thread-scope model pick, when set; else undefined. Symbolic allowed. */
  threadModel?: string;
  /** Thread-scope effort pick, when set; else undefined. Symbolic allowed. */
  threadEffort?: EffortDefault;
  /** Per-Run model override, when present; else undefined. Always concrete. */
  modelOverride?: string;
  /** Per-Run effort override, when present; else undefined. Always concrete. */
  effortOverride?: ThinkingEffort;
  /** The Agent's harness-authored backend (native | claude-code | codex). */
  backend: AgentBackend;
  /**
   * Thread-scope Agent-Backend pick, when set; else undefined. Wins over the
   * user agent default and the harness backend (ADR-0015: per-conversation >
   * agent default). A concrete id (no symbolic backend).
   */
  threadBackend?: AgentBackend;
  /**
   * User's sticky per-agent Agent-Backend default (apply-to-default), when set;
   * else undefined. Sits between the Thread pick and the harness backend.
   */
  userBackendDefault?: AgentBackend;
  /**
   * Runnable model catalog (credentialed ∩ routable, newest-first). Supplies
   * the symbolic resolver: "latest" → catalog head, "highest" → strongest
   * supported level of the resolved model. Absent on call sites with no
   * symbolic tiers (a symbolic winner then surfaces as a typed failure).
   */
  runnableCatalog?: RunnableCatalog;
};

export type ResolveResult =
  | { model: string; provider: string; effort?: ThinkingEffort; backend: AgentBackend }
  | { model: string; failure: GatewayFailure };

// Narrow an Agent's harness `config.thinkingEffort` (an `unknown` from the open
// config record) to a concrete `ThinkingEffort` or the symbolic "highest", or
// `undefined` if absent / not a recognized value — the closed-enum membership
// check the loop relied on inline, now also admitting the symbolic token. Uses
// the shared `isThinkingEffort` (P3).
function configuredEffort(raw: unknown): EffortDefault | undefined {
  const s = typeof raw === "string" ? raw : undefined;
  if (isThinkingEffort(s)) return s;
  return isSymbolicEffort(s) ? "highest" : undefined;
}

export function resolve(input: ResolveInput): ResolveResult {
  const modelResult = resolveAgentModel({
    configuredModel: input.configuredModel,
    userModelDefault: input.userModelDefault,
    ...(input.threadModel !== undefined ? { threadModel: input.threadModel } : {}),
    ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
    ...(input.runnableCatalog !== undefined ? { runnableCatalog: input.runnableCatalog } : {}),
  });
  if ("failure" in modelResult) {
    return { model: modelResult.model, failure: modelResult.failure };
  }

  // Effort tier (mirrors model + Thread scope): per-Run override > Thread scope
  // > user default > harness config.thinkingEffort > undefined (no `thinking`
  // block — the no-effort-fallback invariant, ADR-0013).
  const effortWinner: EffortDefault | undefined =
    input.effortOverride ??
    input.threadEffort ??
    input.userEffortDefault ??
    configuredEffort(input.configuredEffort);

  // Symbolic-resolve pass (S2): "highest" → the strongest level the RESOLVED
  // model supports. Use the efforts a symbolic model resolution already carried;
  // otherwise look the resolved model up in the runnable catalog. Absent efforts
  // ⇒ undefined ⇒ no `thinking` block (preserves the no-effort-fallback).
  let effort: ThinkingEffort | undefined;
  if (isSymbolicEffort(effortWinner)) {
    const efforts =
      modelResult.efforts ??
      input.runnableCatalog?.models.find((m) => m.model === modelResult.model)?.efforts ??
      [];
    effort = resolveHighestEffort(efforts);
  } else {
    effort = effortWinner;
  }

  // Backend tier (ADR-0015): Thread-scope pick > user agent default > harness-
  // authored backend. No per-Run backend override exists today (no symbolic
  // backend either — a concrete discriminator). Same precedence shape as model/
  // effort, with the harness backend as the terminal fallback.
  const backend: AgentBackend = input.threadBackend ?? input.userBackendDefault ?? input.backend;

  return {
    model: modelResult.model,
    provider: modelResult.provider,
    ...(effort !== undefined ? { effort } : {}),
    backend,
  };
}
