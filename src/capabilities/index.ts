// Public API for the Capability Registry. See docs/adr/0007-capability-lifecycle-and-storage.md.

export { createRegistry, RegistryCollisionError } from "./registry.ts";
export type { CreateRegistryOptions } from "./registry.ts";
export { scanAll } from "./loader.ts";
export type { LoaderError, LoaderResult } from "./loader.ts";
export type {
  Capability,
  McpCapability,
  Registry,
  RegistryEvents,
  ResolutionAddress,
  SkillCapability,
  SnippetCapability,
} from "./types.ts";
export {
  HarnessManifest,
  McpManifest,
  SkillManifest,
  SnippetManifest,
  Compatibility,
  Source,
} from "./schemas.ts";
