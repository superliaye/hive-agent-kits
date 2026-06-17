// Model catalog — a STATIC per-backend list. The vendor SDKs authenticate from
// ambient OS login or API-key env vars and own LLM transport; Hive no longer
// needs a live model registry. The runnable list is a fixed per-provider table,
// filtered to the providers that exist as backends.
//
// The tiered resolver SHAPE is unchanged (symbolic.ts / resolve-model.ts /
// resolve.ts still consume `RunnableCatalog`); only the catalog SOURCE changes.

import { EFFORT_ORDER, type ThinkingEffort } from "../lib/effort.ts";
import { BackendFailure } from "./backends/stream-events.ts";

// A model the runtime can route, surfaced by the models-catalog endpoint.
// `model` is the "provider/modelId" string the executor and Run route consume.
export type AvailableModel = {
  provider: string;
  modelId: string;
  model: string;
  label?: string;
  // Supported thinking-effort levels (a subset of ThinkingEffort, always incl.
  // "off"). The composer's effort dropdown shows exactly these.
  efforts: ThinkingEffort[];
};

// The full canonical effort set, applied to every static model. Hive owns no
// per-model effort registry now; each backend clamps unsupported levels at its
// adapter (Codex drops "off"; Claude has no typed effort knob).
const ALL_EFFORTS: ThinkingEffort[] = [...EFFORT_ORDER];

// The static per-provider model table. Ids are derived ONLY from model ids
// already referenced in this repo: anthropic ids from the bundled agent
// harnesses (config.model / modelFallback) and MODEL_FALLBACK; openai-codex ids
// from the agent-prefs / threads / runs test fixtures.
const STATIC_MODELS: Record<string, readonly string[]> = {
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "openai-codex": ["gpt-5.10", "gpt-5.9", "gpt-5.5", "gpt-5.4-mini", "gpt-5.2"],
};

// Parse the provider prefix off a "provider/model" string. A malformed model is
// a typed failure the caller classifies (the executor → invalid_request;
// title-gen silently skips).
export function parseModelProvider(
  model: string,
): { provider: string } | { failure: BackendFailure } {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    return {
      failure: new BackendFailure({
        code: "invalid_request",
        message: `model must be "provider/model"; got: ${JSON.stringify(model)}`,
      }),
    };
  }
  return { provider: model.slice(0, slash) };
}

// Newest-first ordering WITHIN a provider (numeric-aware so 5.10 > 5.9).
export function orderByRecency(models: readonly AvailableModel[]): AvailableModel[] {
  return [...models].sort((a, b) => {
    const byId = b.modelId.localeCompare(a.modelId, undefined, { numeric: true });
    return byId !== 0 ? byId : b.model.localeCompare(a.model);
  });
}

// Enumerate the static models for `provider`, as AvailableModels. A provider
// with no static table yields []. Newest-first within the provider.
export function listModelsForProvider(provider: string): AvailableModel[] {
  const ids = STATIC_MODELS[provider];
  if (!ids) return [];
  const mapped = ids.map(
    (id): AvailableModel => ({
      provider,
      modelId: id,
      model: `${provider}/${id}`,
      efforts: ALL_EFFORTS,
    }),
  );
  return orderByRecency(mapped);
}

// The runnable-catalog snapshot the symbolic resolver consumes: ordered
// newest-first per provider, laid out across providers by PROVIDER_PREFERENCE.
export type RunnableCatalog = {
  /** Newest-first runnable models. Empty when no provider is available. */
  models: readonly AvailableModel[];
};

// Cross-provider winner ordering. Within a provider, recency decides; ACROSS
// providers the catalog is laid out in this fixed preference order — NOT a
// lexical id sort. A symbolic "latest" therefore prefers the strongest provider
// that is actually available: anthropic when present, else openai-codex.
// Providers absent from this list sort after the listed ones and tie-break by
// `localeCompare` so the ordering is self-contained. Seeded per ADR-0015.
export const PROVIDER_PREFERENCE: readonly string[] = ["anthropic", "openai-codex"];

// Narrow, consumer-owned port — only the verb the catalog builder reads. Reports
// which backend providers exist (have a backend installed / a Secret set), so the
// catalog filters the static table to providers the deployment can actually use.
export type RunnableCatalogSecretsPort = {
  list(): ReadonlyArray<{ provider: string }>;
};

// The SINGLE place the runnable catalog is assembled: the static per-provider
// table ∩ the providers that exist (`secrets.list`), ordered newest-first WITHIN
// each provider and laid out ACROSS providers by PROVIDER_PREFERENCE. Every
// consumer (the executor's RunnableCatalogPort, the title-gen path, and `GET
// /api/models`) goes through this so "latest" and the picker's data source are
// the same globally-ordered list. `listModels` is injectable so the
// ordering/intersection logic stays unit-testable.
export function runnableCatalog(
  secrets: RunnableCatalogSecretsPort,
  listModels: (provider: string) => AvailableModel[] = listModelsForProvider,
): RunnableCatalog {
  const available = secrets.list().map((p) => p.provider);
  const rank = (provider: string) => {
    const i = PROVIDER_PREFERENCE.indexOf(provider);
    return i === -1 ? PROVIDER_PREFERENCE.length : i;
  };
  const ordered = [...available].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  // Order newest-first WITHIN each provider here too, so an injected lister that
  // returns unordered models still yields a correctly-ordered catalog (the real
  // listModelsForProvider already orders, so this is idempotent there).
  const models = ordered.flatMap((provider) => orderByRecency(listModels(provider)));
  return { models };
}
