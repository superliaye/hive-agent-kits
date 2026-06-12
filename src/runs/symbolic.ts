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

import { orderByRecency } from "../model-gateway/index.ts";
import type { AvailableModel, ThinkingEffort } from "../model-gateway/types.ts";
import { EFFORT_ORDER } from "../model-gateway/types.ts";

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

// The runnable-catalog snapshot the symbolic resolver consumes: the credentialed
// ∩ routable models, already ordered newest-first per provider (the explicit
// catalog ordering ADR-0015 asks for, surfaced via the gateway seam). The
// executor builds this once per Run and passes it into resolve().
export type RunnableCatalog = {
  /** Newest-first runnable models. Empty when no provider is credentialed+routable. */
  models: readonly AvailableModel[];
};

// "latest" → the first runnable model (the catalog is newest-first). Returns
// undefined when the runnable catalog is empty — the caller maps that to a
// typed failure (no runnable model to resolve a symbolic default to).
export function resolveLatestModel(catalog: RunnableCatalog): AvailableModel | undefined {
  return catalog.models[0];
}

// Cross-provider winner ordering for the runnable catalog. Within a provider,
// recency (`orderByRecency`) decides; ACROSS providers the catalog is laid out
// in this fixed preference order — NOT a lexical cross-provider id sort (which
// would let an "openai-codex/gpt-9" outrank an "anthropic/claude-opus" purely on
// the id string). A symbolic "latest" therefore prefers the strongest provider
// that is actually credentialed: anthropic when present, else openai-codex.
// Providers absent from this list sort after the listed ones, and tie-break
// among themselves by `provider.localeCompare` so the catalog's ordering is
// self-contained (NOT silently coupled to `secrets.list()`'s incoming order).
// Seeded per ADR-0015; extend as providers are added.
export const PROVIDER_PREFERENCE: readonly string[] = ["anthropic", "openai-codex"];

// Narrow, consumer-owned ports for the shared catalog builder — only the two
// verbs it reads. The composition root passes the real Secrets / ModelGateway;
// the gateway never learns about secrets (the intersection is computed HERE,
// not inside the gateway — P2).
export type RunnableCatalogSecretsPort = {
  list(): ReadonlyArray<{ provider: string }>;
};
export type RunnableCatalogGatewayPort = {
  listModels(provider: string): AvailableModel[];
};

// The SINGLE place the runnable catalog is assembled (P2): credentialed
// (`secrets.list`) ∩ routable (`gateway.listModels`), ordered newest-first
// WITHIN each provider (`orderByRecency`) and laid out ACROSS providers by
// `PROVIDER_PREFERENCE`. Every consumer (the executor's RunnableCatalogPort, the
// title-gen path, and `GET /api/models`) goes through this so "latest" and the
// picker's data source are the same globally-ordered list.
export function runnableCatalog(
  secrets: RunnableCatalogSecretsPort,
  gateway: RunnableCatalogGatewayPort,
): RunnableCatalog {
  const credentialed = secrets.list().map((p) => p.provider);
  const rank = (provider: string) => {
    const i = PROVIDER_PREFERENCE.indexOf(provider);
    return i === -1 ? PROVIDER_PREFERENCE.length : i;
  };
  const ordered = [...credentialed].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const models = ordered.flatMap((provider) => orderByRecency(gateway.listModels(provider)));
  return { models };
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
