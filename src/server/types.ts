// HTTP wire types and request-body schemas for the daemon's /api routes.

import { z } from "zod";
import { AgentBackend, CapabilityKind, CapabilityLayer, KebabName, Origin } from "../lib/capability-types.ts";

export const BindingPatchBody = z
  .object({
    kind: z.enum(["skill", "snippet", "tool", "mcp"]),
    name: KebabName,
    action: z.enum(["bind", "unbind"]),
  })
  .strict();
export type BindingPatchBody = z.infer<typeof BindingPatchBody>;

export const CapabilityKindQuery = CapabilityKind;

// Public capability shape exposed over HTTP. Mirrors the in-memory Capability
// minus the manifest body and per-kind details (kept light for list views).
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
};

// Envelope for events delivered over /api/events (SSE).
export type WireEvent = {
  source: "registry" | "catalog" | "config" | "gateway";
  type: string;
  payload: unknown;
};
