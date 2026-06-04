// createAudit() — the public seam per ADR-0004.
// Two verbs: attach(source, events, normalizer) and query(filter).
// Block-on-failure: a normalizer throw or persist failure bubbles up through
// the originating emit, failing the caller's operation. No silent drops.
//
// Implementation is Effect-native (`AuditLive`, ADR-0011 Phase 4.2); this
// factory is a thin ManagedRuntime proxy preserving the legacy `Audit` surface
// for unmigrated consumers. There is no new Effect verb here (and so no typed
// `E`) — see audit-live.ts.

import { ManagedRuntime } from "effect";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import { AuditLive, Audit as AuditTag, type CreateAuditOptions } from "./effect/audit-live.ts";
import type { AuditEvent, AuditQueryFilter, ModuleSource, Normalizer } from "./types.ts";

export type Audit = {
  // Normalizer can be partial — only the event keys present are subscribed.
  // This lets callers attach to a TypedEmitter and audit only a subset
  // (e.g., user-action events) without auditing the rest.
  attach<TEventMap extends Record<string, unknown>>(
    source: ModuleSource,
    events: TypedEmitter<TEventMap>,
    normalizer: Partial<Normalizer<TEventMap>>,
  ): () => void;
  query(filter: AuditQueryFilter): Promise<AuditEvent[]>;
  subscriptions(): readonly ModuleSource[];
};

export type { CreateAuditOptions } from "./effect/audit-live.ts";

// Retained (§4.3): production resolves `Audit` off the root runtime; this proxy
// stays for the plain-async legacy-surface suites (`audit/__tests__/audit.test.ts`,
// `subscriptions.test.ts`). The migrated lifecycle is covered by
// `audit/effect/__tests__/audit-live.test.ts`. Delete it only when those migrate.
export function createAudit(opts: CreateAuditOptions): Audit {
  const runtime = ManagedRuntime.make(AuditLive(opts));
  // acquire is synchronous (bun:sqlite open), so runSync resolves the service.
  const svc = runtime.runSync(AuditTag);
  // No dispose on the legacy surface — createAudit() callers (unit tests + the
  // standalone path) never disposed audit before. The handle close runs at the
  // ROOT path (server/index.ts), not here.
  return {
    attach: svc.attach,
    query: svc.query,
    subscriptions: svc.subscriptions,
  };
}
