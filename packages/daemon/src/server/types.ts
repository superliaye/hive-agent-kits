// HTTP wire types and request-body schemas for the daemon's /api routes.

import { z } from "zod";
import type { BackendReadiness } from "../backend-readiness/index.ts";
import { KebabName } from "../lib/capability-types.ts";

// Mirrors the ModuleSource union in src/audit/types.ts. Kept here so the
// HTTP boundary validates incoming source filters without leaking the audit
// module's types into route signatures.
export const ModuleSourceSchema = z.enum(["config", "secrets", "backend", "deploy"]);

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

// ─── Secrets ──────────────────────────────────────────────────────────────

// POST /api/secrets/:provider/api-key body.
export const SetApiKeyBody = z
  .object({
    apiKey: z.string().min(1).max(2048),
  })
  .strict();
export type SetApiKeyBody = z.infer<typeof SetApiKeyBody>;

export type ConfiguredProviderWire = {
  provider: string;
  kind: "apiKey" | "oauth";
  status: "ok" | "expired";
  addedAt: number;
  refreshedAt?: number;
};

// ─── Backend Readiness (GET /api/backends/readiness) ──────────────────────

// The readiness projection's wire shape IS the backend-readiness Zod schema's
// inferred type — no parallel redefinition. The route Zod-validates with the
// schema itself at the boundary (BackendReadiness.array().parse).
export type BackendReadinessWire = BackendReadiness;
