// Effect-native Audit module (ADR-0011, Phase 4.2 — the last module migration
// before §4.3 deletes the proxies). See docs/adr/0004-audit-log-design.md.
//
// `Audit` is the Context.Service tag; `AuditLive(opts)` a layer that owns the
// audit SQLite handle. Consumers resolve this service off a `ManagedRuntime`
// (the root one in production, a per-test one in the suites).
//
// Sync, not async (the load-bearing honesty point). `openAuditDb` (Database
// ctor + drizzle), `persist` (.run()), and `runQuery` (.all()) are all sync
// over bun:sqlite — so acquire/release use `Effect.sync`, NOT `Effect.tryPromise`
// (AGENTS.md "plain async only at I/O edges"). More subtly, the per-event
// listener stays a DIRECT sync call to `persist`: lifting it into
// `Effect.promise(...).runPromise` would run the write on a microtask, taking a
// normalizer/persist throw OFF the synchronous stack of `TypedEmitter.emit` and
// breaking block-on-failure (ADR-0004 #4 — the throw must reject the awaiting
// emit). The Effect-native win here is the layer/lifecycle (scoped open+close),
// not Effectifying the hot write path.
//
// No typed `E` this slice. Unlike Secrets (`requireAuth`) and Catalog
// (`requireAgent`), Audit exposes no new Effect verb: the proxy surface
// (attach/query/subscriptions) is unchanged, and the only failures (a normalizer
// throw, a persist failure) must bubble AS the original thrown value through
// `emit` to preserve block-on-failure and the exact error identity the tests
// assert. Wrapping them in a `Data.TaggedError` would change that identity, so
// there is no errors.ts — this is the honest taxonomy, not a gap.
//
// `Layer.scoped` is absent in effect@4.0.0-beta.75 — `Layer.effect` over
// `Effect.acquireRelease` is the scoped-resource constructor.

import { Context, Effect, Layer } from "effect";
import type { TypedEmitter } from "../../lib/typed-emitter.ts";
import { type AuditDb, openAuditDb } from "../db.ts";
import { runQuery } from "../query.ts";
import { redactValue } from "../redaction.ts";
import { auditEvents } from "../schema.ts";
import type {
  AuditEvent,
  AuditQueryFilter,
  ModuleSource,
  Normalizer,
  NormalizerOutput,
} from "../types.ts";

export type CreateAuditOptions = { mode: "file"; path: string } | { mode: "memory" };

// The service VALUE is the legacy Audit surface byte-for-byte (attach/query/
// subscriptions) — nothing more. The DB handle is captured in AuditLive's
// acquire/release closure, NOT published here: a raw drizzle handle has no place
// on the service contract (ADR-0011 clean-interface); only `release` needs it.
export type AuditSvc = {
  attach<TEventMap extends Record<string, unknown>>(
    source: ModuleSource,
    events: TypedEmitter<TEventMap>,
    normalizer: Partial<Normalizer<TEventMap>>,
  ): () => void;
  query(filter: AuditQueryFilter): Promise<AuditEvent[]>;
  subscriptions(): readonly ModuleSource[];
};

export class Audit extends Context.Service<Audit, AuditSvc>()("audit/Audit") {}

export function AuditLive(opts: CreateAuditOptions): Layer.Layer<Audit> {
  const path = opts.mode === "memory" ? ":memory:" : opts.path;
  return Layer.effect(
    Audit,
    Effect.acquireRelease(
      // DB open is SYNCHRONOUS (bun:sqlite Database ctor + drizzle); mirror HiveDbLive.
      // Keep the handle next to the svc so `release` can close it without
      // publishing it on the service value.
      Effect.sync(() => {
        const db = openAuditDb(path);
        return { svc: buildSvc(db), db };
      }),
      // Close the handle no one closed pre-4.2 (4.1b left audit close to this slice).
      ({ db }) => Effect.sync(() => db.$client.close()),
    ).pipe(Effect.map(({ svc }) => svc)),
  );
}

// Per-instance closure — the four PRESERVED invariants (block-on-failure, sync
// persist, dedupe, seq tiebreaker) live here.
function buildSvc(db: AuditDb): AuditSvc {
  const subscribed: ModuleSource[] = [];
  // In-memory monotonic counter — tiebreaker when two emits land in the same
  // microsecond. Per-instance; resets on process restart.
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
      // Synchronous listener — persist() is sync (bun:sqlite is sync). A
      // normalizer or persist throw propagates up through TypedEmitter.emit to
      // the awaiting emit site (block-on-failure). Deliberately NOT lifted into
      // an Effect: runPromise would defer the throw off emit's stack.
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
