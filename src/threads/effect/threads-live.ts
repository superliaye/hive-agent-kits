// Effect-native Threads module (ADR-0011, Phase 4).
//
// `Threads` is the Context.Service tag; `ThreadsLive()` a layer that builds the
// `ThreadsStore` over the SHARED root `HiveDb` handle. Unlike the other Lives,
// ThreadsLive owns NO sqlite handle of its own — it yields `HiveDb` from context
// and wraps it, so the layer's requirement is `HiveDb` (discharged at the root,
// not leaked). That borrowed-handle shape is the proof Threads does not open a
// second `hive.db` connection; open + close belong to `HiveDbLive`.
//
// No typed `E`: Threads is pure synchronous CRUD with no failure that earns the
// error channel. Its one throw (`ThreadNotFoundError`, store.ts) is raised inside
// an `append` transaction and surfaces unchanged through the legacy surface; no
// consumer narrows on it as a domain precondition (contrast Catalog's
// `requireAgent`/`CatalogAgentNotFound`). So `ThreadsSvc` is exactly the legacy
// `ThreadsStore` surface — no Effect-returning verbs.

import { Context, Effect, Layer } from "effect";
import { HiveDb } from "../../db/effect/hive-db-live.ts";
import { createThreadsStore, type ThreadsStore } from "../store.ts";

export type ThreadsSvc = ThreadsStore;

export class Threads extends Context.Service<Threads, ThreadsSvc>()("threads/Threads") {}

export function ThreadsLive(): Layer.Layer<Threads, never, HiveDb> {
  // No `acquireRelease`: the store is a pure value over a borrowed handle.
  // Release belongs to HiveDbLive — Threads opens nothing to close.
  return Layer.effect(
    Threads,
    Effect.gen(function* () {
      const db = yield* HiveDb;
      return createThreadsStore(db);
    }),
  );
}
