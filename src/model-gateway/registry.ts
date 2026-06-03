// Per-instance adapter registry. Created by `createGateway()` in index.ts.
//
// Was previously a module-global Map with a `_resetRegistry()` test hatch.
// The factory shape removes the global state, matches the audit/config
// `createX(opts)` pattern, and lets tests instantiate isolated gateways
// without reaching into module internals.

import { Effect } from "effect";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import { GatewayFailure } from "./effect/failure.ts";
import { GatewayError } from "./errors.ts";
import type { GatewayAdapter, GatewayModuleEvents } from "./types.ts";

export type GatewayRegistry = {
  registerAdapter(adapter: GatewayAdapter): () => void;
  /** Throwing resolution — the legacy `complete()` path. */
  resolve(model: string): GatewayAdapter;
  /** Effect resolution — failures land in the typed `E` channel. */
  resolveEffect(model: string): Effect.Effect<GatewayAdapter, GatewayFailure>;
  events: TypedEmitter<GatewayModuleEvents>;
};

export function createGatewayRegistry(): GatewayRegistry {
  const adapters = new Map<string, GatewayAdapter>();
  const events = new TypedEmitter<GatewayModuleEvents>();

  function registerAdapter(adapter: GatewayAdapter): () => void {
    for (const provider of adapter.providers) {
      adapters.set(provider, adapter);
    }
    void events.emit("adapter.registered", { providers: adapter.providers });
    return () => {
      for (const provider of adapter.providers) {
        if (adapters.get(provider) === adapter) {
          adapters.delete(provider);
        }
      }
      void events.emit("adapter.unregistered", { providers: adapter.providers });
    };
  }

  // Single parse+lookup, returning the failure as a value. The throwing and
  // Effect resolvers below are thin shells over it, so both report identical
  // codes and messages.
  function lookup(model: string): { adapter: GatewayAdapter } | { failure: GatewayFailure } {
    const slash = model.indexOf("/");
    if (slash < 1 || slash === model.length - 1) {
      return {
        failure: new GatewayFailure({
          code: "invalid_request",
          message: `model must be "provider/model"; got: ${JSON.stringify(model)}`,
        }),
      };
    }
    const provider = model.slice(0, slash);
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

  return { registerAdapter, resolve, resolveEffect, events };
}
