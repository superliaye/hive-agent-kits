// The conformance-error shape for the capability format (ADR-0024). The strict
// `validate` gate (in @hive/capability-schema-tools) PRODUCES these; both that
// tools package and @hive/contract (the add-on-validate wire report) CONSUME the
// same type from this pure SSOT — one definition, no structural mirror.

import { z } from "zod";

// A located conformance violation: which kind/name failed and why. `kind`/`name`
// stay free-form strings (not the CapabilityKind enum) — a violation can be
// surfaced for content that never resolved to a known kind.
export const ConformanceError = z.object({
  kind: z.string(),
  name: z.string(),
  message: z.string(),
});
export type ConformanceError = z.infer<typeof ConformanceError>;
