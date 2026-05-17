// Wire-up of module event streams → Audit, per ADR-0004.
//
// Each emitter module passes its `events` emitter to this function; audit
// attaches via its uniform subscribe API. New emitter modules add a
// parameter and a `case` here when they ship — reading this file gives
// the full graph of who feeds the audit log.

import type { Config, ConfigEvents } from "../config/types.ts";
import type { ModelGateway } from "../model-gateway/index.ts";
import type { GatewayModuleEvents } from "../model-gateway/types.ts";
import type { Audit } from "./audit.ts";
import type { Normalizer } from "./types.ts";

export type AuditSources = {
  config?: Config<Record<string, unknown>>;
  gateway?: ModelGateway;
  // Future:
  //   registry?:   { events: TypedEmitter<RegistryEvents> }
  //   catalog?:    { events: TypedEmitter<CatalogEvents> }
  //   run?:        { events: TypedEmitter<RunEvents> }
  //   permission?: { events: TypedEmitter<PermissionEvents> }
  //   secrets?:    { events: TypedEmitter<SecretEvents> }
  //   mcp?:        { events: TypedEmitter<McpLifecycleEvents> }
  //   memory?:     { events: TypedEmitter<MemoryEvents> }
  //   lifecycle?:  { events: TypedEmitter<AgentLifecycleEvents> }
};

const configNormalizer: Normalizer<ConfigEvents<Record<string, unknown>>> = {
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

// Attaches every present source's event stream to the audit log.
// Returns a disposer that detaches all listeners.
export function wireSubscriptions(audit: Audit, sources: AuditSources = {}): () => void {
  const disposers: Array<() => void> = [];

  if (sources.config) {
    disposers.push(audit.attach("config", sources.config.events, configNormalizer));
  }

  if (sources.gateway) {
    disposers.push(audit.attach("gateway", sources.gateway.events, gatewayNormalizer));
  }

  return () => {
    for (const d of disposers) d();
  };
}
