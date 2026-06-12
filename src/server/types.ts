// HTTP wire types and request-body schemas for the daemon's /api routes.

import { z } from "zod";
import type { HarnessManifest } from "../capabilities/schemas.ts";
import {
  AgentBackend,
  CapabilityKind,
  CapabilityLayer,
  KebabName,
  Origin,
} from "../lib/capability-types.ts";
import { SYMBOLIC_EFFORT_HIGHEST, SYMBOLIC_MODEL_LATEST } from "../runs/symbolic.ts";

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
  "agent-prefs",
  "thread",
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
// "source" was historically overloaded across three concepts:
//   - The Registry's CapabilitySource enum (`filesystem` | `builtin` | …)
//     describing *how the Registry discovered* the capability. Now exposed
//     as `discovery` on the wire.
//   - The manifest's `source: { url, ref }` block describing *where it was
//     vendored from*. Exposed as `upstream` on the wire.
//   - The UI's `SourceFacet` for grouping capabilities by upstream repo —
//     internal to `ui/src/capability-filters.ts`.
// One word, one concept. The wire enum is the LEAST visible of the three,
// so it gets the new name (`discovery`); `upstream` and `SourceFacet`
// already had clearer names.
export type CapabilityWire = {
  name: string;
  kind: z.infer<typeof CapabilityKind>;
  description: string;
  origin: z.infer<typeof Origin>;
  layer: z.infer<typeof CapabilityLayer>;
  discovery: string;
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
  // Per-Agent run_shell command allowlist (read-only here). Surfaced from the
  // Agent / HarnessManifest field so the C5 Backends UI can render it; editing
  // is C5's concern, not this endpoint.
  commandAllowlist?: HarnessManifest["commandAllowlist"];
  // Populated when a runtime fork file exists but failed to parse; the
  // resolved agent falls back to bundled. UI shows a banner.
  forkError?: string;
};

// Envelope for events delivered over /api/events (SSE).
export type WireEvent = {
  source: "registry" | "catalog" | "config" | "gateway" | "run";
  type: string;
  payload: unknown;
};

// ─── Threads + Runs (Part 4a) ─────────────────────────────────────────────

// Wire ContentBlock — Zod-validated at the HTTP boundary. The shape *is*
// the canonical `ContentBlock` from model-gateway/types.ts; the schema
// validates inbound JSON against that single source of truth.
// Per AGENTS.md "Zod at every external boundary".
//
// `tool_result` has a recursive `content` field (string or nested
// ContentBlock[]). Zod discriminated unions can't be lazy, so the
// outer schema is a plain union; runtime discrimination happens via
// `type` literals. TS's interaction between `z.lazy` and explicit
// `z.ZodType<T>` annotations fights us on recursive unions; the cast on
// the lazy wrapper says "this schema parses `unknown` and outputs
// ContentBlock" — true at runtime.
import type { ContentBlock as DaemonContentBlock } from "../model-gateway/types.ts";
import { EFFORT_ORDER } from "../model-gateway/types.ts";

const ContentBlockSchema: z.ZodType<DaemonContentBlock> = z.lazy(
  () => ContentBlockUnion,
) as z.ZodType<DaemonContentBlock>;

const ContentBlockUnion = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool_use"),
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      tool_use_id: z.string().min(1),
      content: z.union([z.string(), z.array(ContentBlockSchema)]),
      is_error: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thinking"),
      thinking: z.string(),
      signature: z.string().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      source: z
        .object({
          type: z.enum(["base64", "url"]),
          media_type: z.string().optional(),
          data: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export { ContentBlockSchema };

// POST /api/threads body.
export const CreateThreadBody = z
  .object({
    agentId: KebabName,
  })
  .strict();
export type CreateThreadBody = z.infer<typeof CreateThreadBody>;

// PUT /api/threads/:id/title body. A user-chosen title pins `titleSource` to
// `manual` (sticky — auto-title never clobbers it). 200 cap is a sane bound.
export const SetThreadTitleBody = z
  .object({
    title: z.string().min(1).max(200),
  })
  .strict();
export type SetThreadTitleBody = z.infer<typeof SetThreadTitleBody>;

// Thinking-effort levels accepted at the HTTP boundary. Inferred from the
// canonical `EFFORT_ORDER` tuple (src/model-gateway/types.ts) — the closed set
// of levels any provider can express — so this boundary enum can't drift from
// `ThinkingEffort`. The catalog's per-model `efforts` narrows which are valid
// for a given model; this is the boundary sanity-check.
export const EffortLevel = z.enum(EFFORT_ORDER);

const ModelOverride = z
  .string()
  .min(1)
  // "provider/model" — gateway registry rejects malformed; just sanity-check.
  .regex(/^[^/]+\/.+$/, "must be 'provider/model-id'");

// POST /api/threads/:id/runs body. `userMessage` is the next user turn —
// content blocks (typically a single text block, but tool_results land
// here too for the upcoming Part 7 tool-execution loop). `modelOverride` /
// `effortOverride` are the per-Run overrides; the executor walks each:
// override → per-agent default → harness config → fallback.
export const StartRunBody = z
  .object({
    userMessage: z.array(ContentBlockSchema).min(1),
    modelOverride: ModelOverride.optional(),
    effortOverride: EffortLevel.optional(),
  })
  .strict();
export type StartRunBody = z.infer<typeof StartRunBody>;

// Default-tier values may be SYMBOLIC (ADR-0015 S2): a default is a rule
// ("latest" model / "highest" effort) resolved at Run start, not a pinned id.
// These admit the symbolic token OR a concrete value — used by the agent
// default (apply-to-default) and the Thread scope (use-here), NEVER by a per-Run
// override (which stays strictly concrete: ModelOverride / EffortLevel above).
const DefaultModel = z.union([z.literal(SYMBOLIC_MODEL_LATEST), ModelOverride]);
const DefaultEffort = z.union([z.literal(SYMBOLIC_EFFORT_HIGHEST), EffortLevel]);

// PUT /api/agents/:id/model-pref body. Sets the user's sticky model and/or
// thinking-effort default for an Agent (the tier between Thread scope and the
// harness config) — the apply-to-default target (ADR-0015: a separate act from
// use-here). Both fields optional and independent — omitting one leaves the
// stored value unchanged (merge semantics). At least one must be present (a
// no-op body is rejected). A default may be symbolic.
export const SetAgentModelPrefBody = z
  .object({
    model: DefaultModel.optional(),
    effort: DefaultEffort.optional(),
  })
  .strict()
  .refine((b) => b.model !== undefined || b.effort !== undefined, {
    message: "at least one of { model, effort } is required",
  });
export type SetAgentModelPrefBody = z.infer<typeof SetAgentModelPrefBody>;

// PUT /api/threads/:id/scope body. Sets the conversation-scope pick (ADR-0015
// S1 + ADR-0016 C4: use-here — applies to THIS Thread and sticks for its later
// Runs, without touching the agent default). `model`/`effort` may be symbolic;
// `workingDir` is a plain filesystem path (not a model/effort token, so no
// `DefaultModel`-style union). All fields optional and independent (merge
// semantics); `null` clears an axis (back to the agent default). At least one
// field must be present.
export const SetThreadScopeBody = z
  .object({
    model: DefaultModel.nullable().optional(),
    effort: DefaultEffort.nullable().optional(),
    workingDir: z.string().nullable().optional(),
  })
  .strict()
  .refine((b) => b.model !== undefined || b.effort !== undefined || b.workingDir !== undefined, {
    message: "at least one of { model, effort, workingDir } is required",
  });
export type SetThreadScopeBody = z.infer<typeof SetThreadScopeBody>;

// Wire shapes returned by GET endpoints.

export type ThreadSummaryWire = {
  id: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  titleSource: "auto" | "manual";
  archivedAt: number | null;
  status: "idle" | "running" | "unread" | "failed";
};

export type ThreadDetailWire = ThreadSummaryWire & {
  messages: Array<{
    id: string;
    idx: number;
    role: "user" | "assistant";
    content: DaemonContentBlock[];
    createdAt: number;
  }>;
};

export type RunWire = {
  id: string;
  threadId: string;
  agentId: string;
  model: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
};

// ─── Secrets (Part 4b) ────────────────────────────────────────────────────

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

export type OAuthProviderWire = {
  id: string;
  name: string;
};
