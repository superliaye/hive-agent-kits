// Per-instance adapter registry. Created by `createGateway()` in index.ts.
//
// Was previously a module-global Map with a `_resetRegistry()` test hatch.
// The factory shape removes the global state, matches the audit/config
// `createX(opts)` pattern, and lets tests instantiate isolated gateways
// without reaching into module internals.

import { TypedEmitter } from "../lib/typed-emitter.ts";
import { GatewayError } from "./errors.ts";
import type { GatewayAdapter, GatewayModuleEvents } from "./types.ts";

export type GatewayRegistry = {
  registerAdapter(adapter: GatewayAdapter): () => void;
  resolve(model: string): GatewayAdapter;
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

  function resolve(model: string): GatewayAdapter {
    const slash = model.indexOf("/");
    if (slash < 1 || slash === model.length - 1) {
      throw new GatewayError(
        "invalid_request",
        `model must be "provider/model"; got: ${JSON.stringify(model)}`,
      );
    }
    const provider = model.slice(0, slash);
    const adapter = adapters.get(provider);
    if (!adapter) {
      throw new GatewayError("model_not_found", `no adapter registered for provider: ${provider}`);
    }
    return adapter;
  }

  return { registerAdapter, resolve, events };
}
