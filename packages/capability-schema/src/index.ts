// @hive/capability-schema — the single source of truth for Hive's capability
// format (ADR-0024). Pure: zod is the only dependency; no fs/http/exec/Effect/
// crypto. Type names stay neutral (no "Hive" prefix) so the format can graduate
// to a published standard.

// Hive's own capability-format version — distinct from the SKILL.md standard,
// which has no version field. Emitted, not validated against a boundary.
export const formatVersion = "1";

export * from "./identity.ts";
export * from "./kinds/skill.ts";
export * from "./layout.ts";
