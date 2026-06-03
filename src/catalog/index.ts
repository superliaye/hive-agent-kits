// Public API for the Agent Catalog. See docs/adr/0007-capability-lifecycle-and-storage.md.
//
// Implementation is Effect-native (`CatalogLive`, ADR-0011 Phase 3b); this
// factory is a thin ManagedRuntime proxy preserving the legacy `Catalog`
// surface for unmigrated consumers (the server). The Effect-native typed-error
// verb (`requireAgent`) is on the `Catalog` service, not this proxy.

import { ManagedRuntime } from "effect";
import type { CreateCatalogOptions } from "./catalog.ts";
import { CatalogLive, Catalog as CatalogTag } from "./effect/catalog-live.ts";
import type { Catalog } from "./types.ts";

export function createCatalog(opts?: CreateCatalogOptions): Catalog {
  const runtime = ManagedRuntime.make(CatalogLive(opts));
  const svc = runtime.runSync(CatalogTag);
  return {
    list: svc.list,
    get: svc.get,
    updateBindings: svc.updateBindings,
    resetToBundled: svc.resetToBundled,
    start: svc.start,
    rescan: svc.rescan,
    events: svc.events,
    dispose: () => {
      void runtime.dispose();
    },
  };
}

export { AgentNotFoundError } from "./catalog.ts";
export type { CreateCatalogOptions } from "./catalog.ts";
export { scanAll } from "./loader.ts";
export type { LoaderError, LoaderResult } from "./loader.ts";
export type { Agent, BindingKind, BindingPatch, Catalog, CatalogEvents } from "./types.ts";
