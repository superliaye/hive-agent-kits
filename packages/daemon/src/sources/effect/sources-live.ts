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

import type { AddSourceInput, Source } from "@hive/contract";
import { Context, Effect, Layer } from "effect";
import { log } from "../../lib/log.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { SourcesPersistence } from "../persistence.ts";
import { createSourcesStore, type ReorderDirection, type SourcesStore } from "../store.ts";
import { SOURCES_FILE_VERSION, type SourcesAuditEvents, type SourcesFile } from "../types.ts";
import { DuplicateOrigin, SourceIoError, SourceNotFound } from "./errors.ts";

export type CreateSourceRegistryOptions =
  | { mode: "memory"; initial?: Source[] }
  | { mode: "file"; path: string; seedFixtureSources?: boolean };

export type SourceRegistrySvc = {
  list(): Effect.Effect<readonly Source[], SourceIoError>;
  // Synchronous getters over one in-memory registry. Consumers that join the
  // revision with Sources use currentSnapshot() so both come from one clone.
  currentSources(): readonly Source[];
  currentSnapshot(): SourcesFile;
  add(input: AddSourceInput): Effect.Effect<Source, DuplicateOrigin | SourceIoError>;
  activate(id: string): Effect.Effect<Source, SourceNotFound | SourceIoError>;
  deactivate(id: string): Effect.Effect<Source, SourceNotFound | SourceIoError>;
  delete(id: string): Effect.Effect<void, SourceNotFound | SourceIoError>;
  // Raise/lower a Source one precedence step (a free total-order swap). A swap at
  // the requested end is a clean no-op (returns the unchanged Source); an unknown
  // id is SourceNotFound.
  reorder(
    id: string,
    direction: ReorderDirection,
  ): Effect.Effect<Source, SourceNotFound | SourceIoError>;
  // Audit source emitter (source: 'sources').
  events: TypedEmitter<SourcesAuditEvents>;
};

export class SourceRegistry extends Context.Service<SourceRegistry, SourceRegistrySvc>()(
  "sources/SourceRegistry",
) {}

// The bundled Starter Source seeded on a truly-first file-mode run (ADR-0023):
// the in-repo content package, local (no network Sync), active by default. It
// REPLACES the old remote `my-agent-kits` seed — `my-agent-kits` is now just a
// Source the user may add by URL like any other. Fixed well-known id + a non-URL
// origin sentinel so the seed is idempotent and the add route's GitHttpsUrl never
// applies to it.
const STARTER_SOURCE_ID = "starter";
const STARTER_SOURCE_ORIGIN = "local:starter";

export const DEV_FIXTURE_SOURCES = [
  { id: "fixture-alpha", origin: "local:fixture-alpha" },
  { id: "fixture-beta", origin: "local:fixture-beta" },
  { id: "fixture-gamma", origin: "local:fixture-gamma" },
] as const;

function openStore(opts: CreateSourceRegistryOptions): SourcesStore {
  if (opts.mode === "memory") {
    // Memory mode never seeds and writes no file.
    return createSourcesStore({
      version: SOURCES_FILE_VERSION,
      revision: 0,
      sources: opts.initial ?? [],
    });
  }
  const persist = new SourcesPersistence(opts.path);
  // First-run seeding: gate on persist.exists() — NOT read()-returns-empty,
  // which can't distinguish a missing file from an empty one. A user who DELETES
  // the default (leaving `{version,sources:[]}` on disk) must not see it
  // re-seeded, so only a truly-absent file seeds.
  const store = createSourcesStore(persist.read(), persist);
  // Seed when there is no usable current-version registry: an absent file OR a
  // stale-version file that read() discarded as EMPTY. A present same-version file
  // (even an empty one after the user deleted the Starter) is NOT re-seeded —
  // delete-no-reseed holds. (Plain `!exists()` would skip the re-seed for a
  // discarded stale file and boot into an empty registry — review finding.)
  if (!persist.isCurrentVersion()) {
    // Seed the bundled Starter Source. A SYSTEM action, not a user `add` — it goes
    // through the store's `seedLocal` (kind:"local"), which is OFF the audited
    // service `add()` path, so first-run seeding emits NO `source.added` audit
    // event (AGENTS.md "Audit vs trace": seeding is not a user action). A write
    // fault here must NOT crash daemon boot (openStore runs inside the Layer
    // build) — degrade to the unseeded store and trace it, matching how the route
    // verbs ioGuard their persistence faults.
    const seeds = [
      { id: STARTER_SOURCE_ID, origin: STARTER_SOURCE_ORIGIN },
      ...(opts.seedFixtureSources ? DEV_FIXTURE_SOURCES : []),
    ];
    for (const seed of seeds) {
      try {
        store.seedLocal(seed.id, seed.origin);
      } catch (err) {
        log().warn(
          { module: "sources", sourceId: seed.id, err: String(err) },
          "first-run local Source seed write failed; continuing with available registry",
        );
      }
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

    currentSnapshot: () => store.snapshot(),

    add: (input) =>
      Effect.flatMap(
        ioGuard(() => store.add(input)),
        (res) =>
          res.ok
            ? Effect.promise(() =>
                events.emit("source.added", { id: res.source.id, origin: res.source.origin }),
              ).pipe(Effect.as(res.source))
            : Effect.fail(
                new DuplicateOrigin({
                  origin:
                    input.locator.kind === "git" ? input.locator.repoUrl : input.locator.repoRoot,
                }),
              ),
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

    reorder: (id, direction) =>
      Effect.flatMap(
        ioGuard(() => store.reorder(id, direction)),
        (res) => {
          if (!res.ok) return Effect.fail(new SourceNotFound({ id }));
          // Emit the audit row only for a genuine swap (ranks moved + persisted) —
          // a no-op (already at the requested end) wrote nothing, so it records no
          // user-action row (AGENTS.md: audit reflects a real mutation).
          if (!res.changed) return Effect.succeed(res.source);
          return Effect.promise(() =>
            events.emit("source.reordered", { id, rank: res.source.rank }),
          ).pipe(Effect.as(res.source));
        },
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
