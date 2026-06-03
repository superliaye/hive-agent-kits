// createAudit() — the public seam per ADR-0004.
// Two verbs: attach(source, events, normalizer) and query(filter).
// Block-on-failure: a normalizer throw or persist failure bubbles up through
// the originating emit, failing the caller's operation. No silent drops.

import type { TypedEmitter } from "../lib/typed-emitter.ts";
import { type AuditDb, openAuditDb } from "./db.ts";
import { runQuery } from "./query.ts";
import { redactValue } from "./redaction.ts";
import { auditEvents } from "./schema.ts";
import type {
  AuditEvent,
  AuditQueryFilter,
  ModuleSource,
  Normalizer,
  NormalizerOutput,
} from "./types.ts";

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

export type CreateAuditOptions = { mode: "file"; path: string } | { mode: "memory" };

export function createAudit(opts: CreateAuditOptions): Audit {
  const path = opts.mode === "memory" ? ":memory:" : opts.path;
  const db = openAuditDb(path);
  const subscribed: ModuleSource[] = [];
  // In-memory monotonic counter — tiebreaker when two emits land in the
  // same microsecond. Per-Audit-instance; resets on process restart.
  let seq = 0;

  function attach<TEventMap extends Record<string, unknown>>(
    source: ModuleSource,
    events: TypedEmitter<TEventMap>,
    normalizer: Partial<Normalizer<TEventMap>>,
  ): () => void {
    // Silent dedupe — calling attach() twice for the same source is almost
    // always a bug, but we want subscriptions() to return one entry per source.
    if (!subscribed.includes(source)) {
      subscribed.push(source);
    }
    const disposers: Array<() => void> = [];
    for (const eventType of Object.keys(normalizer) as Array<keyof TEventMap>) {
      const fn = normalizer[eventType];
      if (!fn) continue;
      // Synchronous listener — persist() is sync (bun:sqlite is sync).
      // Returns void; TypedEmitter accepts both void and Promise<void>.
      disposers.push(
        events.on(eventType, (event) => {
          const result = fn(event);
          persist(db, source, ++seq, result);
        }),
      );
    }
    return () => {
      for (const d of disposers) d();
      const idx = subscribed.indexOf(source);
      if (idx >= 0) subscribed.splice(idx, 1);
    };
  }

  return {
    attach,
    query: (filter) => Promise.resolve(runQuery(db, filter)),
    subscriptions: () => [...subscribed],
  };
}

// Microseconds since epoch, anchored to the wall clock. `Date.now()` is the
// NTP-corrected wall time (millisecond resolution); ×1000 expresses it in the
// microsecond unit the audit log records. Ordering *within* a millisecond is
// handled by the monotonic `seq` counter, so we deliberately avoid
// `performance.now()`, whose monotonic clock drifts from wall time over a
// long-running process (a forensic-accuracy bug, and the cause of a full-suite
// timestamp-assertion flake).
function microsecondsNow(): number {
  return Date.now() * 1000;
}

function persist(db: AuditDb, source: ModuleSource, seq: number, output: NormalizerOutput): void {
  db.insert(auditEvents)
    .values({
      id: crypto.randomUUID(),
      ts: microsecondsNow(),
      seq,
      run_id: output.run_id ?? null,
      agent_id: output.agent_id ?? null,
      source,
      event_type: output.event_type,
      payload: redactValue(output.payload),
      parent_event_id: output.parent_event_id ?? null,
      prev_hash: null,
      signature: null,
    })
    .run();
}
