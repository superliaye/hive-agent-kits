// Capability Registry types per ADR-0007.
//
// The Registry holds resolved Capability entries (runtime > bundled) and
// exposes a uniform event stream the audit subscriber attaches to.

import type {
  CapabilityKind,
  CapabilityLayer,
  CapabilitySource,
  Origin,
} from "../lib/capability-types.ts";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { McpManifest, SkillManifest, SnippetManifest } from "./schemas.ts";

// Where a Capability was resolved from. Workplace bundled entries carry a
// workplaceId; runtime entries never do.
export type ResolutionAddress = {
  layer: CapabilityLayer;
  origin: Origin;
  workplaceId?: string;
};

type CapabilityBase = {
  name: string;
  description: string;
  origin: Origin;
  source: CapabilitySource;
  layer: CapabilityLayer;
  workplaceId?: string;
  // Absolute path to the manifest file.
  path: string;
  // If this entry shadowed bundled entries during resolution, they appear here.
  shadows?: ResolutionAddress[];
};

export type SkillCapability = CapabilityBase & {
  kind: "skill";
  manifest: SkillManifest;
  body: string;
};

export type SnippetCapability = CapabilityBase & {
  kind: "snippet";
  manifest: SnippetManifest;
  body: string;
};

export type McpCapability = CapabilityBase & {
  kind: "mcp";
  manifest: McpManifest;
};

export type Capability = SkillCapability | SnippetCapability | McpCapability;

// Event stream consumed by the audit subscriber (and any future UI listener).
export type RegistryEvents = {
  "capability.registered": {
    name: string;
    kind: CapabilityKind;
    origin: Origin;
    layer: CapabilityLayer;
    source: CapabilitySource;
    shadows?: ResolutionAddress[];
  };
  "capability.unregistered": {
    name: string;
    kind: CapabilityKind;
    origin: Origin;
    layer: CapabilityLayer;
  };
  "capability.changed": {
    name: string;
    kind: CapabilityKind;
    origin: Origin;
    layer: CapabilityLayer;
  };
};

export type Registry = {
  list(filter?: { kind?: CapabilityKind }): readonly Capability[];
  get(kind: CapabilityKind, name: string): Capability | undefined;
  // Performs the initial scan and emits register events. Caller must wire
  // audit subscribers (via wireSubscriptions) before calling start().
  start(): Promise<void>;
  // Force a fresh scan; useful in tests and after CLI-driven runtime drops.
  rescan(): Promise<void>;
  events: TypedEmitter<RegistryEvents>;
  dispose(): void;
};
