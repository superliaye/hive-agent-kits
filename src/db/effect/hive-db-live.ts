// Effect-native ownership of the shared `hive.db` handle (ADR-0011, Phase 2).
//
// `HiveDb` is the Context.Service tag; `HiveDbLive(path)` is a scoped layer
// that owns open + dispose of the underlying `bun:sqlite` Database. Layer
// memoization means every consumer that depends on `HiveDb` shares one
// connection; `ManagedRuntime.dispose()` closes it exactly once.
//
// `Layer.scoped` is absent in effect@4.0.0-beta.75 — `Layer.effect` over
// `Effect.acquireRelease` is the scoped-resource constructor (it discharges
// the Scope automatically). The `mode`-driven path (`:memory:` vs the on-disk
// hive.db) is selected by the caller at the composition root; that is root
// configuration, not a leaked requirement.

import { Context, Effect, Layer } from "effect";
import { type HiveDb as HiveDbHandle, openHiveDb } from "../hive-db.ts";

export class HiveDb extends Context.Service<HiveDb, HiveDbHandle>()("HiveDb") {}

export function HiveDbLive(path: string): Layer.Layer<HiveDb> {
  return Layer.effect(
    HiveDb,
    Effect.acquireRelease(
      Effect.sync(() => openHiveDb(path)),
      (db) => Effect.sync(() => db.$client.close()),
    ),
  );
}
