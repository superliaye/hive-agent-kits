import { GatewayError } from "./errors.ts";
import type { GatewayAdapter } from "./types.ts";

const registry = new Map<string, GatewayAdapter>();

export function registerAdapter(adapter: GatewayAdapter): void {
  for (const provider of adapter.providers) {
    registry.set(provider, adapter);
  }
}

export function resolve(model: string): GatewayAdapter {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw new GatewayError(
      "invalid_request",
      `model must be "provider/model"; got: ${JSON.stringify(model)}`,
    );
  }
  const provider = model.slice(0, slash);
  const adapter = registry.get(provider);
  if (!adapter) {
    throw new GatewayError("model_not_found", `no adapter registered for provider: ${provider}`);
  }
  return adapter;
}

// Test-only helper — keeps adapter registrations isolated between tests.
export function _resetRegistry(): void {
  registry.clear();
}
