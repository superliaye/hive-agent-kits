// Typed errors for the Catalog `E` channel (ADR-0011, Phase 3b). The legacy
// `createCatalog()` surface keeps throwing `AgentNotFoundError` (catalog.ts) —
// `server/routes.ts` narrows on it; this is for the Effect-native verbs.

import { Data } from "effect";

// A lookup targeted an agent with no resolved entry. Surfaced by the
// Effect-native `requireAgent`; the legacy async mutation verbs still throw
// the `AgentNotFoundError` class.
export class CatalogAgentNotFound extends Data.TaggedError("CatalogAgentNotFound")<{
  readonly agentId: string;
}> {}
