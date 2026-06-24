// Effect-native Sources registry (ADR-0023). The Sources bounded context's
// persistence + registry core — entity, store, the five lifecycle verbs.
//
// `SourceRegistry` is the Context.Service tag; `SourceRegistryLive(opts)` a
// layer that owns the in-memory store (reading persistence at build in file
// mode). Mirrors `secrets/effect/secrets-live.ts`: a memory|file mode so a
// memory-mode daemon boot touches no real `~/.hive/sources.json`.
//
// Errors are values in `E` (errors.ts). The store is plain (an I/O edge); the
// service maps its result shapes into the typed channel.
//
// Audit: each successful mutation emits one event on `events` (source: 'sources').
// The Audit module subscribes via `wireSubscriptions`; nothing calls audit
// directly. Mirrors the deploy emitter (`kit/effect/kit-live.ts`) — the awaited
// `emit` preserves block-on-failure (an audit persist fault fails the op).

import type { Source } from "@hive/contract";
import { Context, Effect, Layer } from "effect";
import { log } from "../../lib/log.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { SourcesPersistence } from "../persistence.ts";
import { createSourcesStore, type SourcesStore } from "../store.ts";
import { SOURCES_FILE_VERSION, type SourcesAuditEvents } from "../types.ts";
import { DuplicateOrigin, SourceIoError, SourceNotFound } from "./errors.ts";

export type CreateSourceRegistryOptions =
  | { mode: "memory"; initial?: Source[] }
  | { mode: "file"; path: string };

export type SourceRegistrySvc = {
  list(): Effect.Effect<readonly Source[], SourceIoError>;
  add(origin: string): Effect.Effect<Source, DuplicateOrigin | SourceIoError>;
  activate(id: string): Effect.Effect<Source, SourceNotFound | SourceIoError>;
  deactivate(id: string): Effect.Effect<Source, SourceNotFound | SourceIoError>;
  delete(id: string): Effect.Effect<void, SourceNotFound | SourceIoError>;
  // Audit source emitter (source: 'sources').
  events: TypedEmitter<SourcesAuditEvents>;
};

export class SourceRegistry extends Context.Service<SourceRegistry, SourceRegistrySvc>()(
  "sources/SourceRegistry",
) {}

function openStore(opts: CreateSourceRegistryOptions): SourcesStore {
  if (opts.mode === "memory") {
    return createSourcesStore({
      version: SOURCES_FILE_VERSION,
      sources: opts.initial ?? [],
    });
  }
  const persist = new SourcesPersistence(opts.path);
  return createSourcesStore(persist.read(), persist);
}

// Run a synchronous store verb, mapping a thrown persistence fault into the
// typed `SourceIoError`. The store's own result discriminants (duplicate /
// not-found) are mapped by the callers below. The full error (which may carry an
// absolute fs path) goes to the trace log; the typed error carries only a
// generic message so a 500 body never leaks the user's home path.
function ioGuard<A>(thunk: () => A): Effect.Effect<A, SourceIoError> {
  return Effect.try({
    try: thunk,
    catch: (err) => {
      log().warn({ module: "sources", err: String(err) }, "source registry persistence error");
      return new SourceIoError({ message: "source registry persistence error" });
    },
  });
}

function buildSvc(store: SourcesStore): SourceRegistrySvc {
  const events = new TypedEmitter<SourcesAuditEvents>();

  return {
    events,

    list: () => ioGuard(() => store.list()),

    add: (origin) =>
      Effect.flatMap(
        ioGuard(() => store.add(origin)),
        (res) =>
          res.ok
            ? Effect.promise(() =>
                events.emit("source.added", { id: res.source.id, origin: res.source.origin }),
              ).pipe(Effect.as(res.source))
            : Effect.fail(new DuplicateOrigin({ origin })),
      ),

    activate: (id) =>
      Effect.flatMap(
        ioGuard(() => store.activate(id)),
        (res) =>
          res.ok
            ? Effect.promise(() => events.emit("source.activated", { id })).pipe(
                Effect.as(res.source),
              )
            : Effect.fail(new SourceNotFound({ id })),
      ),

    deactivate: (id) =>
      Effect.flatMap(
        ioGuard(() => store.deactivate(id)),
        (res) =>
          res.ok
            ? Effect.promise(() => events.emit("source.deactivated", { id })).pipe(
                Effect.as(res.source),
              )
            : Effect.fail(new SourceNotFound({ id })),
      ),

    delete: (id) =>
      Effect.flatMap(
        ioGuard(() => store.delete(id)),
        (res) =>
          res.ok
            ? Effect.promise(() => events.emit("source.removed", { id }))
            : Effect.fail(new SourceNotFound({ id })),
      ),
  };
}

export function SourceRegistryLive(opts: CreateSourceRegistryOptions): Layer.Layer<SourceRegistry> {
  return Layer.effect(
    SourceRegistry,
    Effect.acquireRelease(
      Effect.sync(() => buildSvc(openStore(opts))),
      () => Effect.void,
    ),
  );
}
