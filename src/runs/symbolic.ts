// Symbolic default values (ADR-0015 S2) and their resolution against the
// runnable model catalog.
//
// A *default* tier (harness config.model / config.thinkingEffort, the user's
// per-agent default, or a Thread-scope pick) may carry a SYMBOLIC value — a
// rule resolved at Run start — instead of a pinned id:
//
//   - model  : "latest"  → the top of the runnable catalog (provider-scoped,
//                          newest-first), so the resolved id is guaranteed to
//                          be a credentialed ∩ routable model (fixes finding #3:
//                          root no longer resolves to an uncredentialed
//                          anthropic id out of the box).
//   - effort : "highest" → the strongest level the RESOLVED model supports
//                          (its `efforts` subset), ordered by EFFORT_ORDER.
//
// Symbolic tokens are reserved strings that cannot collide with a concrete
// value: "latest" has no "/" (so it is never a valid "provider/model"), and
// "highest" is not a member of EFFORT_ORDER. They are allowed ONLY in default
// tiers — never as a per-Run override (ADR-0015: an override is always
// concrete). The HTTP boundary enforces that (server/types.ts).

import { EFFORT_ORDER, type ThinkingEffort } from "../lib/effort.ts";
import type { AvailableModel, RunnableCatalog } from "./model-catalog.ts";

export type { RunnableCatalog } from "./model-catalog.ts";
export { PROVIDER_PREFERENCE, runnableCatalog } from "./model-catalog.ts";

export const SYMBOLIC_MODEL_LATEST = "latest";
export const SYMBOLIC_EFFORT_HIGHEST = "highest";

export type SymbolicModel = typeof SYMBOLIC_MODEL_LATEST;
export type SymbolicEffort = typeof SYMBOLIC_EFFORT_HIGHEST;

export function isSymbolicModel(value: string | undefined): value is SymbolicModel {
  return value === SYMBOLIC_MODEL_LATEST;
}

export function isSymbolicEffort(value: string | undefined): value is SymbolicEffort {
  return value === SYMBOLIC_EFFORT_HIGHEST;
}

// A default-tier effort value: a concrete level OR the symbolic "highest". A
// per-Run override stays strictly concrete (this never admits "highest"). The
// SINGLE shared shape both resolve() and the executor's Thread-scope narrowing
// reference (P3), so the two cannot drift.
export type EffortDefault = ThinkingEffort | SymbolicEffort;

// Concrete-effort membership check against the canonical EFFORT_ORDER. Shared by
// resolve()'s harness-config narrowing and the executor's Thread-scope narrowing
// (P3) — one definition, no per-call-site re-spelling.
export function isThinkingEffort(value: string | undefined): value is ThinkingEffort {
  return value !== undefined && (EFFORT_ORDER as readonly string[]).includes(value);
}

// "latest" → the first runnable model (the catalog is newest-first). Returns
// undefined when the runnable catalog is empty — the caller maps that to a
// typed failure (no runnable model to resolve a symbolic default to).
export function resolveLatestModel(catalog: RunnableCatalog): AvailableModel | undefined {
  return catalog.models[0];
}

// "highest" → the strongest supported level in `efforts`, ordered by the
// canonical EFFORT_ORDER. Returns undefined when `efforts` is empty (no level
// to pick) — preserves the no-effort-fallback invariant (the caller then sends
// no `thinking` block).
export function resolveHighestEffort(
  efforts: readonly ThinkingEffort[],
): ThinkingEffort | undefined {
  let best: ThinkingEffort | undefined;
  let bestRank = -1;
  for (const e of efforts) {
    const rank = EFFORT_ORDER.indexOf(e);
    if (rank > bestRank) {
      bestRank = rank;
      best = e;
    }
  }
  return best;
}
