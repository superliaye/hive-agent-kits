// Public API for the Agent Catalog. See docs/adr/0007-capability-lifecycle-and-storage.md.

export { AgentNotFoundError, createCatalog } from "./catalog.ts";
export type { CreateCatalogOptions } from "./catalog.ts";
export { scanAll } from "./loader.ts";
export type { LoaderError, LoaderResult } from "./loader.ts";
export type { Agent, BindingKind, BindingPatch, Catalog, CatalogEvents } from "./types.ts";
