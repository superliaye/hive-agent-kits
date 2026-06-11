// Per-instance adapter registry. Created by `createGateway()` in index.ts.
//
// Was previously a module-global Map with a `_resetRegistry()` test hatch.
// The factory shape removes the global state, matches the audit/config
// `createX(opts)` pattern, and lets tests instantiate isolated gateways
// without reaching into module internals.

import { Effect } from "effect";
import { log } from "../lib/log.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import { GatewayFailure } from "./effect/failure.ts";
import { GatewayError } from "./errors.ts";
import type { AvailableModel, GatewayAdapter, GatewayModuleEvents } from "./types.ts";

// Canonical "provider/model" parse. The single place the slash convention is
// decoded — `lookup` below and every non-gateway consumer (the Run model
// resolver) route through this rather than hand-rolling `indexOf("/")`. Returns
// the parsed provider as a value, or a typed failure with the same code/message
// the gateway resolvers report.
export function parseModelProvider(
  model: string,
): { provider: string } | { failure: GatewayFailure } {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    return {
      failure: new GatewayFailure({
        code: "invalid_request",
        message: `model must be "provider/model"; got: ${JSON.stringify(model)}`,
      }),
    };
  }
  return { provider: model.slice(0, slash) };
}

export type GatewayRegistry = {
  registerAdapter(adapter: GatewayAdapter): () => void;
  /** Throwing resolution — the legacy `complete()` path. */
  resolve(model: string): GatewayAdapter;
  /** Effect resolution — failures land in the typed `E` channel. */
  resolveEffect(model: string): Effect.Effect<GatewayAdapter, GatewayFailure>;
  /** Models the registered adapter for `provider` can route; [] if unroutable. */
  listModels(provider: string): AvailableModel[];
  events: TypedEmitter<GatewayModuleEvents>;
};

// Deterministic, provider-scoped recency ordering over a catalog (ADR-0015 S2:
// an explicit catalog ordering the symbolic "latest" resolver consumes, not an
// adapter implementation detail). Newest-first by model id, numeric-aware so
// "5.10" > "5.9"; ties broken by the full id for stability. The gateway owns
// this so pi-ai stays imported only in its adapter (ADR-0005).
export function orderByRecency(models: readonly AvailableModel[]): AvailableModel[] {
  return [...models].sort((a, b) => {
    const byId = b.modelId.localeCompare(a.modelId, undefined, { numeric: true });
    return byId !== 0 ? byId : b.model.localeCompare(a.model);
  });
}

export function createGatewayRegistry(): GatewayRegistry {
  const adapters = new Map<string, GatewayAdapter>();
  const events = new TypedEmitter<GatewayModuleEvents>();

  function registerAdapter(adapter: GatewayAdapter): () => void {
    for (const provider of adapter.providers) {
      adapters.set(provider, adapter);
    }
    events
      .emit("adapter.registered", { providers: adapter.providers })
      .catch((err) =>
        log().warn({ module: "model-gateway", err: String(err) }, "adapter.registered emit failed"),
      );
    return () => {
      for (const provider of adapter.providers) {
        if (adapters.get(provider) === adapter) {
          adapters.delete(provider);
        }
      }
      events
        .emit("adapter.unregistered", { providers: adapter.providers })
        .catch((err) =>
          log().warn(
            { module: "model-gateway", err: String(err) },
            "adapter.unregistered emit failed",
          ),
        );
    };
  }

  // Single parse+lookup, returning the failure as a value. The throwing and
  // Effect resolvers below are thin shells over it, so both report identical
  // codes and messages.
  function lookup(model: string): { adapter: GatewayAdapter } | { failure: GatewayFailure } {
    const parsed = parseModelProvider(model);
    if ("failure" in parsed) return parsed;
    const { provider } = parsed;
    const adapter = adapters.get(provider);
    if (!adapter) {
      return {
        failure: new GatewayFailure({
          code: "model_not_found",
          message: `no adapter registered for provider: ${provider}`,
        }),
      };
    }
    return { adapter };
  }

  function resolve(model: string): GatewayAdapter {
    const result = lookup(model);
    if ("failure" in result) {
      throw new GatewayError(result.failure.code, result.failure.message);
    }
    return result.adapter;
  }

  function resolveEffect(model: string): Effect.Effect<GatewayAdapter, GatewayFailure> {
    const result = lookup(model);
    return "failure" in result ? Effect.fail(result.failure) : Effect.succeed(result.adapter);
  }

  function listModels(provider: string): AvailableModel[] {
    const adapter = adapters.get(provider);
    if (!adapter?.listModels) return [];
    const mapped = adapter.listModels(provider).map((m) => ({
      provider,
      modelId: m.id,
      model: `${provider}/${m.id}`,
      ...(m.label !== undefined ? { label: m.label } : {}),
      efforts: m.efforts,
    }));
    // Apply the explicit gateway-owned recency ordering (ADR-0015 S2), not the
    // adapter's best-effort internal sort. Deterministic, provider-scoped.
    return orderByRecency(mapped);
  }

  return { registerAdapter, resolve, resolveEffect, listModels, events };
}
