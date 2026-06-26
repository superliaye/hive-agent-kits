// Strict validate over a SourceTree — the conformance gate the CLI uses. Maps
// the SAME enumerateLeaves walk as `parse`, but applies the ratified per-kind
// schemas from capability-schema. Never throws: the assertNameMatchesDir throw is
// caught into a located ConformanceError.
//
// Scope: all five modeled capability kinds — `skill` (ADR-0024), `plugin`
// (ADR-0025), `bundle` (ADR-0026), `agent` (ADR-0027), and `instruction`
// (ADR-0028) — now have ratified per-kind strict schemas, so every enumerated leaf
// is strictly gated. (`mcp` is a deferred FUTURE kind — not in CapabilityKind, so
// the walk never emits it — pending an external evolving spec and a deploy
// adapter; the dispatch's exhaustiveness check would force gating it on the day it
// joins the enum.) Real-world Source content is not assumed conformant — `validate`
// reports violations, it does not reject the Source.

import {
  AgentFrontmatter,
  BundleFrontmatter,
  type CapabilityKind,
  ConformanceError,
  InstructionFrontmatter,
  PluginFrontmatter,
  SkillFrontmatter,
  assertNameMatchesDir,
} from "@hive/capability-schema";
import type { ZodTypeAny } from "zod";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import type { LeafHit } from "./walk.ts";
import type { SourceTree } from "./source-tree.ts";
import { enumerateLeaves } from "./walk.ts";

// Re-exported from the pure SSOT (@hive/capability-schema) so existing importers
// of `ConformanceError` from this tools package keep working — one definition
// (the imported binding carries both the schema value and its inferred type).
export { ConformanceError };

export const ValidationResult = z.object({
  conformant: z.boolean(),
  errors: z.array(ConformanceError),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

export function validate(tree: SourceTree): ValidationResult {
  const walk = enumerateLeaves(tree);
  const errors: ConformanceError[] = [];

  // A present-but-unreadable marker is a conformance failure too.
  for (const p of walk.problems) {
    errors.push({ kind: p.kind, name: p.name, message: p.problem });
  }

  for (const leaf of walk.leaves) {
    if (leaf.kind === "skill") {
      validateFolderName(leaf, SkillFrontmatter, "skill", errors);
    } else if (leaf.kind === "agent") {
      validateFolderName(leaf, AgentFrontmatter, "agent", errors);
    } else if (leaf.kind === "plugin") {
      validateAgainst(leaf, PluginFrontmatter, errors);
    } else if (leaf.kind === "bundle") {
      validateAgainst(leaf, BundleFrontmatter, errors);
    } else if (leaf.kind === "instruction") {
      validateAgainst(leaf, InstructionFrontmatter, errors);
    } else {
      // Exhaustiveness guard: every CapabilityKind the walk can emit is gated
      // above. A future kind added to the enum is a compile error here, not a
      // silent ungated pass.
      const _exhaustive: never = leaf.kind;
      void _exhaustive;
    }
  }

  return { conformant: errors.length === 0, errors };
}

function parseFrontmatterRaw(content: string): unknown {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  return yamlParse(content.slice(3, end).trim());
}

// The single frontmatter gate: parse the marker frontmatter, safeParse against the
// kind's schema, push one located ConformanceError per issue. Returns the validated
// data on success (for callers with an extra cross-file rule), or undefined when it
// reported errors. Robustness contract — absent/unparseable frontmatter yields a
// located error, never a throw.
function validateAgainst(leaf: LeafHit, schema: ZodTypeAny, errors: ConformanceError[]): unknown {
  let raw: unknown;
  try {
    raw = parseFrontmatterRaw(leaf.markerContent ?? "");
  } catch (err) {
    errors.push({ kind: leaf.kind, name: leaf.name, message: `unparseable frontmatter: ${String(err)}` });
    return undefined;
  }

  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const at = issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
    errors.push({ kind: leaf.kind, name: leaf.name, message: `${issue.message}${at}` });
  }
  return undefined;
}

// A folder kind (skill, agent) = the generic gate PLUS the cross-file name==dir
// rule (frontmatter alone can't know its directory). Delegates the
// parse/safeParse/issue-emission to validateAgainst, then runs only the extra
// assertion on the validated data. `kind` labels the assertion message.
function validateFolderName(
  leaf: LeafHit,
  schema: ZodTypeAny,
  kind: CapabilityKind,
  errors: ConformanceError[],
): void {
  const data = validateAgainst(leaf, schema, errors);
  if (data === undefined) return;

  // `name` is optional (lenient superset): when frontmatter omits it — or leaves it
  // blank (`name:` → null) — the directory is the effective name, so there is nothing
  // to match. Only assert name==dir when a name is explicitly declared (a string).
  // Narrow the validated `unknown` to read `name` without a cast.
  const parsedName = typeof data === "object" && data !== null ? toRecord(data).name : undefined;
  if (typeof parsedName === "string") {
    try {
      // `leaf.dir` is the innermost marker dir, so an @-group folder kind validates
      // its name against the leaf dir, not the @-group ancestor.
      assertNameMatchesDir(parsedName, leaf.dir, kind);
    } catch (err) {
      errors.push({ kind: leaf.kind, name: leaf.name, message: String(err instanceof Error ? err.message : err) });
    }
  }
}

// Read an object's own string-keyed properties as unknowns without a cast (spreads
// a typeof-narrowed non-null object into a fresh Record).
function toRecord(value: object): Record<string, unknown> {
  return { ...value };
}
