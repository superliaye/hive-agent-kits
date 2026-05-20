// Wire-up of module event streams → Audit, per ADR-0004.
//
// Each emitter module passes its `events` emitter to this function; audit
// attaches via its uniform subscribe API. New emitter modules add a
// parameter and a `case` here when they ship — reading this file gives
// the full graph of who feeds the audit log.

import type { Appearance } from "../appearance/index.ts";
import type { AppearanceEvents } from "../appearance/types.ts";
import type { Registry } from "../capabilities/index.ts";
import type { Catalog } from "../catalog/index.ts";
import type { CatalogEvents } from "../catalog/types.ts";
import type { Config, ConfigEvents } from "../config/types.ts";
import type { ModelGateway } from "../model-gateway/index.ts";
import type { RunExecutor } from "../runs/index.ts";
import type { RunModuleEvents } from "../runs/types.ts";
import type { Secrets } from "../secrets/index.ts";
import type { SecretEvents } from "../secrets/types.ts";
import type { Audit } from "./audit.ts";
import type { Normalizer } from "./types.ts";

export type AuditSources<S extends Record<string, unknown> = Record<string, unknown>> = {
  config?: Config<S>;
  gateway?: ModelGateway;
  registry?: Registry;
  catalog?: Catalog;
  secrets?: Secrets;
  appearance?: Appearance;
  runs?: RunExecutor;
  // Future:
  //   permission?: { events: TypedEmitter<PermissionEvents> }
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

// Gateway adapter registration is startup-only / diagnostic; trace, not audit.
// When a future flow lets a *user* register a gateway adapter at runtime, we
// can subscribe a filtered normalizer here.

// Catalog: only user/agent-driven side effects are audited. agent.created at
// scan time is system inventory — that goes to trace via the log singleton.
const catalogNormalizer: Partial<Normalizer<CatalogEvents>> = {
  "harness.updated": (event) => ({
    event_type: "harness.updated",
    agent_id: event.agentId,
    payload: { source: event.source, diff: event.diff },
  }),
};

// Registry: all events today are scan-driven or hot-reload-driven (system,
// not user). Trace captures them via the log singleton. When user-initiated
// capability adds land (Settings UI drop-zone), add a normalizer here with
// a filter on the source/origin.

// Secrets: every event is user/agent-driven (read by agent for a Run,
// write/refresh/remove by user via Settings). Payloads carry only the
// provider key — never credential values or refs (ADR-0004 redaction).
// Appearance: theme/font preference changes. User-driven, persisted, so
// they belong in the audit log (under the existing `config` source since
// appearance is conceptually a user-config). Payload is just the mode
// picker — color values are not interesting in audit and could be a
// privacy concern in a future shared-deployment scenario.
const appearanceNormalizer: Normalizer<AppearanceEvents> = {
  "appearance.read": (event) => ({
    event_type: "appearance.read",
    payload: { mode: event.mode },
  }),
  "appearance.changed": (event) => ({
    event_type: "appearance.changed",
    payload: { mode: event.mode },
  }),
};

const secretsNormalizer: Normalizer<SecretEvents> = {
  "secret.read": (event) => ({
    event_type: "secret.read",
    payload: { provider: event.provider, kind: event.kind },
  }),
  "secret.write": (event) => ({
    event_type: "secret.write",
    payload: { provider: event.provider, kind: event.kind, op: event.op },
  }),
  "secret.refresh": (event) => ({
    event_type: "secret.refresh",
    payload: { provider: event.provider },
  }),
  "secret.remove": (event) => ({
    event_type: "secret.remove",
    payload: { provider: event.provider },
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

  // gateway and registry intentionally not attached: their events are
  // system-driven (startup / hot-reload), so they belong in the trace log,
  // not the audit log. See "Audit vs trace" in ADR-0004.
  void sources.gateway;
  void sources.registry;

  if (sources.catalog) {
    disposers.push(audit.attach("catalog", sources.catalog.events, catalogNormalizer));
  }

  if (sources.secrets) {
    disposers.push(audit.attach("secrets", sources.secrets.events, secretsNormalizer));
  }

  if (sources.appearance) {
    disposers.push(audit.attach("config", sources.appearance.events, appearanceNormalizer));
  }

  if (sources.runs) {
    disposers.push(audit.attach("run", sources.runs.events, runsNormalizer));
  }

  return () => {
    for (const d of disposers) d();
  };
}

// Runs: lifecycle only (started/completed/failed/cancelled). Per-token
// model events do NOT flow through the audit log — they're causally
// owned by the streaming consumer (ADR-0004 "audit vs trace"). Run rows
// in `hive.db` are the durable record of what happened; this normalizer
// is for cross-module correlation in `audit.db`.
const runsNormalizer: Normalizer<RunModuleEvents> = {
  "run.started": (event) => ({
    event_type: "run.started",
    run_id: event.runId,
    agent_id: event.agentId,
    payload: { thread_id: event.threadId, model: event.model },
  }),
  "run.completed": (event) => ({
    event_type: "run.completed",
    run_id: event.runId,
    payload: { finish_reason: event.finishReason },
  }),
  "run.failed": (event) => ({
    event_type: "run.failed",
    run_id: event.runId,
    payload: { code: event.code, message: event.message },
  }),
  "run.cancelled": (event) => ({
    event_type: "run.cancelled",
    run_id: event.runId,
    payload: {},
  }),
};
