// HTTP wire types and request-body schemas for the daemon's /api routes.

import { z } from "zod";
import { AgentBackend, CapabilityKind, CapabilityLayer, KebabName, Origin } from "../lib/capability-types.ts";

// Mirrors the ModuleSource union in src/audit/types.ts. Kept here so the
// HTTP boundary validates incoming source filters without leaking the audit
// module's types into route signatures.
export const ModuleSourceSchema = z.enum([
  "run",
  "permission",
  "secrets",
  "mcp",
  "memory",
  "registry",
  "catalog",
  "lifecycle",
  "backend",
  "config",
  "gateway",
]);

// Query params for GET /api/audit. Hono passes everything as strings — coerce
// numeric fields. `limit` is clamped to 1000 server-side as a runaway guard.
export const AuditQueryParams = z
  .object({
    source: ModuleSourceSchema.optional(),
    event_type: z.string().min(1).max(128).optional(),
    agent_id: KebabName.optional(),
    run_id: z.string().min(1).max(128).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    until: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type AuditQueryParams = z.infer<typeof AuditQueryParams>;

export const BindingPatchItem = z
  .object({
    kind: z.enum(["skill", "snippet", "tool", "mcp"]),
    name: KebabName,
    action: z.enum(["bind", "unbind"]),
  })
  .strict();
export type BindingPatchItem = z.infer<typeof BindingPatchItem>;

// PATCH /api/agents/:id/bindings body. Batched all-or-nothing.
export const BindingPatchBody = z
  .object({
    patches: z.array(BindingPatchItem).min(1),
  })
  .strict();
export type BindingPatchBody = z.infer<typeof BindingPatchBody>;

export const CapabilityKindQuery = CapabilityKind;

// Public capability shape exposed over HTTP. Mirrors the in-memory Capability
// minus the manifest body and per-kind details (kept light for list views).
//
// Two distinct "source" concepts here, named to disambiguate:
//   - `source` — CapabilitySource enum (`filesystem` | `builtin` | `mcp-discovered`)
//     describing *how the Registry discovered* the capability.
//   - `upstream` — when the capability is vendored from a git/npm upstream,
//     the manifest's `source: { url, ref }` block. Used by the UI to group
//     "all hyperframes-* skills" together.
export type CapabilityWire = {
  name: string;
  kind: z.infer<typeof CapabilityKind>;
  description: string;
  origin: z.infer<typeof Origin>;
  layer: z.infer<typeof CapabilityLayer>;
  source: string;
  workplaceId?: string;
  shadows?: Array<{ layer: string; origin: string; workplaceId?: string }>;
  tags?: string[];
  upstream?: { url: string; ref: string };
};

export type AgentSummaryWire = {
  agentId: string;
  backend: z.infer<typeof AgentBackend>;
  domain: string;
  layer: z.infer<typeof CapabilityLayer>;
  hasFork: boolean;
  bindingCounts: {
    skills: number;
    snippets: number;
    tools: number;
    mcp: number;
  };
};

export type AgentDetailWire = AgentSummaryWire & {
  bindings: {
    skills: string[];
    snippets: string[];
    tools: string[];
    mcp: string[];
  };
  config: Record<string, unknown>;
  promptBody: string;
  // Populated when a runtime fork file exists but failed to parse; the
  // resolved agent falls back to bundled. UI shows a banner.
  forkError?: string;
};

// Envelope for events delivered over /api/events (SSE).
export type WireEvent = {
  source: "registry" | "catalog" | "config" | "gateway";
  type: string;
  payload: unknown;
};
