// Public API for the Capability Registry. See docs/adr/0007-capability-lifecycle-and-storage.md.

export type {
  BindingResolverSvc,
  ResolvedSkill,
  SkillRegistry,
  SkillResolution,
} from "./effect/binding-resolver.ts";
export {
  BindingResolver,
  BindingResolverLive,
} from "./effect/binding-resolver.ts";
export type { LoaderError, LoaderResult } from "./loader.ts";
export { scanAll } from "./loader.ts";
export type { CreateRegistryOptions } from "./registry.ts";
export { createRegistry, RegistryCollisionError } from "./registry.ts";
export {
  Compatibility,
  HarnessManifest,
  McpManifest,
  SkillManifest,
  SnippetManifest,
  Source,
} from "./schemas.ts";
export type {
  Capability,
  McpCapability,
  Registry,
  RegistryEvents,
  ResolutionAddress,
  SkillCapability,
  SnippetCapability,
} from "./types.ts";
