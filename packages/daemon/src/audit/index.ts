// Public API for the Audit module. See docs/adr/0004-audit-log-design.md.
//
// Implementation is Effect-native (`AuditLive`, ADR-0011 Phase 4.2); consumers
// resolve the `Audit` service off the root `ManagedRuntime` (`createServer()`).
// This barrel re-exports the legacy `Audit` surface type (an alias of the
// service value `AuditSvc`, which `server/` types its resolved handle as) plus
// the module's types. The legacy `createAudit()` proxy was deleted in §4.3 —
// its test suites now build the service via `AuditLive` + a `ManagedRuntime`.

import type { AuditSvc } from "./effect/audit-live.ts";

// The legacy `Audit` surface (attach/query/subscriptions) is exactly the
// service value `AuditSvc`. `server/` types its root-runtime-resolved handle as
// `Audit`; `routes.ts` narrows on it.
export type Audit = AuditSvc;

export type { CreateAuditOptions } from "./effect/audit-live.ts";
export { redactString, redactValue } from "./redaction.ts";
export type { AuditSources } from "./subscriptions.ts";
export { wireSubscriptions } from "./subscriptions.ts";
export type {
  AuditEvent,
  AuditQueryFilter,
  ModuleSource,
  Normalizer,
  NormalizerOutput,
} from "./types.ts";
