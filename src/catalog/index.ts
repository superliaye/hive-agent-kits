// Public API for the Agent Catalog. See docs/adr/0007-capability-lifecycle-and-storage.md.
//
// Implementation is Effect-native (`CatalogLive`, ADR-0011 Phase 3b); consumers
// resolve the `Catalog` service off the root `ManagedRuntime` (`createServer()`).
// This barrel re-exports the legacy types + the throwing `AgentNotFoundError`
// that `server/routes.ts` narrows on. The legacy `createCatalog()` proxy was
// removed in §4.3 — its last consumer (one audit-subscriptions test) now builds
// the service via `CatalogLive` + a `ManagedRuntime`.

export type { CreateCatalogOptions } from "./catalog.ts";
export { AgentNotFoundError } from "./catalog.ts";
export type { LoaderError, LoaderResult } from "./loader.ts";
export { scanAll } from "./loader.ts";
export type { Agent, BindingKind, BindingPatch, Catalog, CatalogEvents } from "./types.ts";
