// Effect-native Catalog module (ADR-0011, Phase 3b).
//
// `Catalog` is the Context.Service tag; `CatalogLive(opts)` a layer owning the
// catalog (and its tiered-store file watchers) — release calls `dispose()`. The
// legacy `createCatalog()` (index.ts) is a thin ManagedRuntime proxy over this.
//
// Scope note: the file watcher lives in the shared `createTieredManifestStore`
// (also used by capabilities), so it is NOT re-implemented as an Effect Stream
// here — that would ripple beyond Catalog. Malformed-manifest parse errors stay
// collected-as-data + trace-logged in catalog.ts (they are skips, not failures).
// The genuine failure — a missing agent — becomes the typed `E` below.

import { Context, Effect, Layer } from "effect";
import { createCatalog as buildCatalog, type CreateCatalogOptions } from "../catalog.ts";
import type { Agent, Catalog as CatalogSurface } from "../types.ts";
import { CatalogAgentNotFound } from "./errors.ts";

export type CatalogSvc = CatalogSurface & {
  /** Effect-native get-or-fail: a missing agent is a typed `E`, not a thrown error. */
  requireAgent(agentId: string): Effect.Effect<Agent, CatalogAgentNotFound>;
};

export class Catalog extends Context.Service<Catalog, CatalogSvc>()("catalog/Catalog") {}

export function CatalogLive(opts?: CreateCatalogOptions): Layer.Layer<Catalog> {
  return Layer.effect(
    Catalog,
    Effect.acquireRelease(
      Effect.sync(() => {
        const cat = buildCatalog(opts);
        const requireAgent = (agentId: string): Effect.Effect<Agent, CatalogAgentNotFound> => {
          const agent = cat.get(agentId);
          return agent ? Effect.succeed(agent) : Effect.fail(new CatalogAgentNotFound({ agentId }));
        };
        return { ...cat, requireAgent };
      }),
      (svc) => Effect.sync(() => svc.dispose()),
    ),
  );
}
