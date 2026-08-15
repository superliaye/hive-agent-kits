// Wire-up of module event streams → Audit, per ADR-0004.
//
// Each emitter module passes its `events` emitter to this function; audit
// attaches via its uniform subscribe API. New emitter modules add a
// parameter and a `case` here when they ship — reading this file gives
// the full graph of who feeds the audit log.

import type { BackendUpdateEvents } from "../backend-probe/index.ts";
import type { Config, ConfigEvents } from "../config/types.ts";
import type { DeployAuditEvents } from "../kit/index.ts";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { SecretEvents } from "../secrets/types.ts";
import type { SourcesAuditEvents } from "../sources/types.ts";
import type { AuditSvc } from "./effect/audit-live.ts";
import type { Normalizer } from "./types.ts";

export type AuditSources<S extends Record<string, unknown> = Record<string, unknown>> = {
  config?: Config<S>;
  // Consumer-owned port: only the event stream is read here (audit attaches to
  // it). Satisfied by SecretsSvc and the server's legacy `Secrets` projection.
  secrets?: { events: TypedEmitter<SecretEvents> };
  // Dedicated `backend` source, the user-triggered delegated CLI-update action.
  // Satisfied by the BackendProbe service's `events`.
  backendUpdate?: { events: TypedEmitter<BackendUpdateEvents> };
  // Dedicated `deploy` source: a Kit deploy is a user action. Consumer-owned
  // port — only the event stream is read here. Payload is a refs-only allow-list
  // {kitSha, perKindCounts, targetClis} (no file contents/secrets), and a deploy
  // has neither run_id nor agent_id (both null).
  deploy?: { events: TypedEmitter<DeployAuditEvents> };
  // Dedicated `sources` source: a Source registry mutation is a user action.
  // Consumer-owned port — only the event stream is read here. Payload is
  // refs-only (SourceId, plus the credential-free origin on add); a registry
  // mutation has neither run_id nor agent_id (both null). Satisfied by
  // SourceRegistrySvc's `events`.
  sourceRegistry?: { events: TypedEmitter<SourcesAuditEvents> };
};

// Generic over S so callers with a typed Config<AppConfig> don't need a cast.
// The `appearance` subtree carries user color choices; those aren't useful in
// audit and could leak personal taste in a future shared-deployment scenario.
// Strip the payload to just the mode picker, matching the privacy posture of
// the pre-fold appearanceNormalizer.
function configNormalizer<S extends Record<string, unknown>>(): Normalizer<ConfigEvents<S>> {
  return {
    change: (event) => ({
      event_type: "config.change",
      payload: {
        key: event.key,
        previous: event.key === "appearance" ? redactAppearance(event.previous) : event.previous,
        current: event.key === "appearance" ? redactAppearance(event.current) : event.current,
        source: event.source,
      },
    }),
  };
}

function redactAppearance(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return { mode: (value as { mode?: string }).mode };
}

// Secrets: every event is user/agent-driven (read by agent for a Run,
// write/refresh/remove by user via Settings). Payloads carry only the
// provider key — never credential values or refs (ADR-0004 redaction).
// (Appearance/theme changes flow through the Config module since the
// fold; their audit rows are `config.change` events with key="appearance".)
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
  audit: AuditSvc,
  sources: AuditSources<S> = {},
): () => void {
  const disposers: Array<() => void> = [];

  if (sources.config) {
    disposers.push(audit.attach("config", sources.config.events, configNormalizer<S>()));
  }

  if (sources.secrets) {
    disposers.push(audit.attach("secrets", sources.secrets.events, secretsNormalizer));
  }

  if (sources.backendUpdate) {
    disposers.push(audit.attach("backend", sources.backendUpdate.events, backendUpdateNormalizer));
  }

  if (sources.deploy) {
    disposers.push(audit.attach("deploy", sources.deploy.events, deployNormalizer));
  }

  if (sources.sourceRegistry) {
    disposers.push(audit.attach("sources", sources.sourceRegistry.events, sourcesNormalizer));
  }

  return () => {
    for (const d of disposers) d();
  };
}

// Deploy: a Kit deploy is a user action. run_id/agent_id are NULL (a deploy has
// neither). Each event has an explicit refs-only allow-list; neither accepted
// plans nor legacy applied results expose file contents, tokens, or secrets.
const deployNormalizer: Normalizer<DeployAuditEvents> = {
  "deploy.accepted": (event) => ({
    event_type: "deploy.accepted",
    run_id: null,
    agent_id: null,
    payload: {
      operationId: event.operationId,
      selectionRevision: event.selectionRevision,
      perKindActionCounts: event.perKindActionCounts,
      targetClis: event.targetClis,
    },
  }),
  "deploy.applied": (event) => ({
    event_type: "deploy.applied",
    run_id: null,
    agent_id: null,
    payload: {
      kitSha: event.kitSha,
      perKindCounts: event.perKindCounts,
      targetClis: event.targetClis,
    },
  }),
  "selection.changed": (event) => ({
    event_type: "selection.changed",
    run_id: null,
    agent_id: null,
    payload: {
      revision: event.revision,
      addedPerKind: event.addedPerKind,
      removedPerKind: event.removedPerKind,
      targetClis: event.targetClis,
    },
  }),
};

// Backend (update action): the user-triggered delegated CLI self-update, on the
// same `backend` AuditSource as the spawn audit. Payload carries REFS only — the
// backend id + the binary NAME invoked (never the full arg vector / env / auth).
const backendUpdateNormalizer: Normalizer<BackendUpdateEvents> = {
  "backend.update.requested": (event) => ({
    event_type: "backend.update.requested",
    payload: { backend: event.backend, binary: event.binary },
  }),
};

// Sources (registry mutation): add/activate/deactivate/delete/reorder are user
// actions. run_id/agent_id are NULL (a registry mutation has neither). Payload is
// REFS only — the opaque SourceId, plus the normalized credential-free origin on
// add (the wire schema already rejects `user:token@` origins), plus the new rank
// on reorder (an integer precedence ref, never file contents/secrets).
const sourcesNormalizer: Normalizer<SourcesAuditEvents> = {
  "source.added": (event) => ({
    event_type: "source.added",
    run_id: null,
    agent_id: null,
    payload: { id: event.id, origin: event.origin },
  }),
  "source.activated": (event) => ({
    event_type: "source.activated",
    run_id: null,
    agent_id: null,
    payload: { id: event.id },
  }),
  "source.deactivated": (event) => ({
    event_type: "source.deactivated",
    run_id: null,
    agent_id: null,
    payload: { id: event.id },
  }),
  "source.removed": (event) => ({
    event_type: "source.removed",
    run_id: null,
    agent_id: null,
    payload: { id: event.id },
  }),
  "source.reordered": (event) => ({
    event_type: "source.reordered",
    run_id: null,
    agent_id: null,
    payload: { id: event.id, rank: event.rank },
  }),
};
