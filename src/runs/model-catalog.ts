// Model catalog — re-homed out of the deleted model-gateway (Migration §3,
// ADR-0015 partial). The tiered resolver SHAPE is unchanged (symbolic.ts /
// resolve-model.ts / resolve.ts still consume `RunnableCatalog`); only the
// catalog SOURCE changes: there is no `ModelGateway.listModels`. The runnable
// list is now derived per provider from pi-ai's model registry (`getModels`) ∩
// the credentialed providers (`secrets.list`).
//
// pi-ai stays a dependency for the Secrets OAuth path (Q-piai); this module is
// the only OTHER place it is imported, and ONLY for model enumeration — never as
// the LLM completion transport (that is gone; the SDK adapters own completion).

import { getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { EFFORT_ORDER, type ThinkingEffort } from "../lib/effort.ts";
import { BackendFailure } from "./backends/stream-events.ts";

// The providers Hive surfaces (the v1 default set). A guard narrows an open
// `string` provider to pi-ai's `KnownProvider` so `getModels` types without a
// cast — an unlisted provider yields no catalog entries.
const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "mistral",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "deepseek",
  "github-copilot",
  "vercel-ai-gateway",
  "fireworks",
  "together",
] as const satisfies readonly KnownProvider[];

function isKnownProvider(p: string): p is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(p);
}

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

// pi-ai's per-model `thinkingLevelMap` → the supported effort levels in canonical
// EFFORT_ORDER. `null` = explicitly unsupported (incl. "off": a model that
// declares off:null always thinks). "off" is offered unless explicitly null; a
// non-"off" level needs an explicit non-null value.
type ThinkingLevelMap = Partial<Record<ThinkingEffort, unknown>>;
function effortsFromThinkingLevelMap(map: ThinkingLevelMap | undefined): ThinkingEffort[] {
  return EFFORT_ORDER.filter((level) => {
    const v = map?.[level];
    if (v === null) return false;
    if (level === "off") return true;
    return v !== undefined;
  });
}

// Enumerate the models pi-ai knows for `provider`, as AvailableModels. A
// provider pi-ai can't enumerate yields []. Newest-first within the provider.
export function listModelsForProvider(provider: string): AvailableModel[] {
  if (!isKnownProvider(provider)) return [];
  let models: ReturnType<typeof getModels<typeof provider>>;
  try {
    models = getModels(provider);
  } catch {
    return [];
  }
  const mapped = models.map((m): AvailableModel => {
    const withMap = m as { id: string; thinkingLevelMap?: ThinkingLevelMap };
    return {
      provider,
      modelId: m.id,
      model: `${provider}/${m.id}`,
      efforts: effortsFromThinkingLevelMap(withMap.thinkingLevelMap),
    };
  });
  return orderByRecency(mapped);
}

// The runnable-catalog snapshot the symbolic resolver consumes: credentialed ∩
// routable, ordered newest-first per provider, laid out across providers by
// PROVIDER_PREFERENCE.
export type RunnableCatalog = {
  /** Newest-first runnable models. Empty when no provider is credentialed+routable. */
  models: readonly AvailableModel[];
};

// Cross-provider winner ordering. Within a provider, recency decides; ACROSS
// providers the catalog is laid out in this fixed preference order — NOT a
// lexical id sort. A symbolic "latest" therefore prefers the strongest provider
// that is actually credentialed: anthropic when present, else openai-codex.
// Providers absent from this list sort after the listed ones and tie-break by
// `localeCompare` so the ordering is self-contained. Seeded per ADR-0015.
export const PROVIDER_PREFERENCE: readonly string[] = ["anthropic", "openai-codex"];

// Narrow, consumer-owned port — only the verb the catalog builder reads.
export type RunnableCatalogSecretsPort = {
  list(): ReadonlyArray<{ provider: string }>;
};

// The SINGLE place the runnable catalog is assembled: credentialed
// (`secrets.list`) ∩ routable (`listModels`, default = pi-ai's registry),
// ordered newest-first WITHIN each provider and laid out ACROSS providers by
// PROVIDER_PREFERENCE. Every consumer (the executor's RunnableCatalogPort, the
// title-gen path, and `GET /api/models`) goes through this so "latest" and the
// picker's data source are the same globally-ordered list. `listModels` is
// injectable so the ordering/intersection logic stays unit-testable without
// pi-ai's live registry.
export function runnableCatalog(
  secrets: RunnableCatalogSecretsPort,
  listModels: (provider: string) => AvailableModel[] = listModelsForProvider,
): RunnableCatalog {
  const credentialed = secrets.list().map((p) => p.provider);
  const rank = (provider: string) => {
    const i = PROVIDER_PREFERENCE.indexOf(provider);
    return i === -1 ? PROVIDER_PREFERENCE.length : i;
  };
  const ordered = [...credentialed].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  // Order newest-first WITHIN each provider here too, so an injected lister that
  // returns unordered models still yields a correctly-ordered catalog (the real
  // listModelsForProvider already orders, so this is idempotent there).
  const models = ordered.flatMap((provider) => orderByRecency(listModels(provider)));
  return { models };
}
