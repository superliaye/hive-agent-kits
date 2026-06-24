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
  // Synchronous getter of the in-memory state, no I/O. The Effect `list()` stays
  // the audited/route read; `currentSources()` feeds the deliberately-sync Kit
  // read model (catalog()/state()/sync()) which has no I/O and thus no
  // SourceIoError to channel. NOT named `snapshot` — the store already has a
  // `snapshot(): SourcesFile` of a different type.
  currentSources(): readonly Source[];
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

// The default Source pre-added on a truly-first file-mode run (q6-preadd-default):
// keeps a fresh install non-empty and the interop catalog test meaningful. Minted
// through the normal `add` path so it gets a real id + createdAt.
const DEFAULT_SOURCE_ORIGIN = "https://github.com/superliaye/my-agent-kits";

function openStore(opts: CreateSourceRegistryOptions): SourcesStore {
  if (opts.mode === "memory") {
    // Memory mode never seeds and writes no file.
    return createSourcesStore({
      version: SOURCES_FILE_VERSION,
      sources: opts.initial ?? [],
    });
  }
  const persist = new SourcesPersistence(opts.path);
  // First-run seeding: gate on persist.exists() — NOT read()-returns-empty,
  // which can't distinguish a missing file from an empty one. A user who DELETES
  // the default (leaving `{version,sources:[]}` on disk) must not see it
  // re-seeded, so only a truly-absent file seeds.
  const store = createSourcesStore(persist.read(), persist);
  if (!persist.exists()) {
    // Seed the default Source. A write fault here must NOT crash daemon boot
    // (openStore runs inside the Layer build) — degrade to the unseeded store and
    // trace it, matching how the route verbs ioGuard their persistence faults.
    try {
      store.add(DEFAULT_SOURCE_ORIGIN);
    } catch (err) {
      log().warn(
        { module: "sources", err: String(err) },
        "first-run default seed write failed; starting with an empty registry",
      );
    }
  }
  return store;
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

    currentSources: () => store.list(),

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
