// Wire-up of module event streams → Audit, per ADR-0004.
//
// Each emitter module passes its `events` emitter to this function; audit
// attaches via its uniform subscribe API. New emitter modules add a
// parameter and a `case` here when they ship — reading this file gives
// the full graph of who feeds the audit log.

import type { Registry } from "../capabilities/index.ts";
import type { RegistryEvents } from "../capabilities/types.ts";
import type { Catalog } from "../catalog/index.ts";
import type { CatalogEvents } from "../catalog/types.ts";
import type { Config, ConfigEvents } from "../config/types.ts";
import type { ModelGateway } from "../model-gateway/index.ts";
import type { GatewayModuleEvents } from "../model-gateway/types.ts";
import type { Audit } from "./audit.ts";
import type { Normalizer } from "./types.ts";

export type AuditSources<S extends Record<string, unknown> = Record<string, unknown>> = {
  config?: Config<S>;
  gateway?: ModelGateway;
  registry?: Registry;
  catalog?: Catalog;
  // Future:
  //   run?:        { events: TypedEmitter<RunEvents> }
  //   permission?: { events: TypedEmitter<PermissionEvents> }
  //   secrets?:    { events: TypedEmitter<SecretEvents> }
  //   mcp?:        { events: TypedEmitter<McpLifecycleEvents> }
  //   memory?:     { events: TypedEmitter<MemoryEvents> }
};

// Generic over S so callers with a typed Config<AppConfig> don't need a cast.
function configNormalizer<S extends Record<string, unknown>>(): Normalizer<ConfigEvents<S>> {
  return {
    change: (event) => ({
      event_type: "config.change",
      payload: {
        key: event.key,
        previous: event.previous,
        current: event.current,
        source: event.source,
      },
    }),
  };
}

const gatewayNormalizer: Normalizer<GatewayModuleEvents> = {
  "adapter.registered": (event) => ({
    event_type: "gateway.adapter.registered",
    payload: { providers: [...event.providers] },
  }),
  "adapter.unregistered": (event) => ({
    event_type: "gateway.adapter.unregistered",
    payload: { providers: [...event.providers] },
  }),
};

const catalogNormalizer: Normalizer<CatalogEvents> = {
  "agent.created": (event) => ({
    event_type: "agent.created",
    agent_id: event.agentId,
    payload: { path: event.path },
  }),
  "agent.destroyed": (event) => ({
    event_type: "agent.destroyed",
    agent_id: event.agentId,
    payload: {},
  }),
  "harness.updated": (event) => ({
    event_type: "harness.updated",
    agent_id: event.agentId,
    payload: { source: event.source, diff: event.diff },
  }),
};

const registryNormalizer: Normalizer<RegistryEvents> = {
  "capability.registered": (event) => ({
    event_type: "capability.registered",
    payload: {
      name: event.name,
      kind: event.kind,
      origin: event.origin,
      layer: event.layer,
      source: event.source,
      shadows: event.shadows,
    },
  }),
  "capability.unregistered": (event) => ({
    event_type: "capability.unregistered",
    payload: {
      name: event.name,
      kind: event.kind,
      origin: event.origin,
      layer: event.layer,
    },
  }),
  "capability.changed": (event) => ({
    event_type: "capability.changed",
    payload: {
      name: event.name,
      kind: event.kind,
      origin: event.origin,
      layer: event.layer,
    },
  }),
};

// Attaches every present source's event stream to the audit log.
// Returns a disposer that detaches all listeners.
export function wireSubscriptions<S extends Record<string, unknown> = Record<string, unknown>>(
  audit: Audit,
  sources: AuditSources<S> = {},
): () => void {
  const disposers: Array<() => void> = [];

  if (sources.config) {
    disposers.push(audit.attach("config", sources.config.events, configNormalizer<S>()));
  }

  if (sources.gateway) {
    disposers.push(audit.attach("gateway", sources.gateway.events, gatewayNormalizer));
  }

  if (sources.registry) {
    disposers.push(audit.attach("registry", sources.registry.events, registryNormalizer));
  }

  if (sources.catalog) {
    disposers.push(audit.attach("catalog", sources.catalog.events, catalogNormalizer));
  }

  return () => {
    for (const d of disposers) d();
  };
}
