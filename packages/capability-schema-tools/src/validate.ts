// Strict validate over a SourceTree — the conformance gate the CLI uses. Maps
// the SAME enumerateLeaves walk as `parse`, but applies the ratified per-kind
// schemas from capability-schema. Never throws: the assertNameMatchesDir throw is
// caught into a located ConformanceError.
//
// Scope: skills are the only ratified per-kind strict schema (ADR-0024), so only
// `skill` leaves are strictly gated; other kinds are accepted (no strict schema
// yet). Real-world Source content is not assumed conformant — `validate` reports
// violations, it does not reject the Source.

import { ConformanceError, SkillFrontmatter, assertNameMatchesDir } from "@hive/capability-schema";
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
      validateSkill(leaf, errors);
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

function validateSkill(leaf: LeafHit, errors: ConformanceError[]): void {
  let raw: unknown;
  try {
    raw = parseFrontmatterRaw(leaf.markerContent ?? "");
  } catch (err) {
    errors.push({ kind: leaf.kind, name: leaf.name, message: `unparseable frontmatter: ${String(err)}` });
    return;
  }

  const result = SkillFrontmatter.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const at = issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
      errors.push({ kind: leaf.kind, name: leaf.name, message: `${issue.message}${at}` });
    }
    return;
  }

  // `name` is optional (lenient superset): when frontmatter omits it — or leaves it
  // blank (`name:` → null) — the directory is the effective name, so there is nothing
  // to match. Only assert name==dir when a name is explicitly declared (a string).
  const parsedName = result.data.name;
  if (typeof parsedName === "string") {
    try {
      // `leaf.dir` is the innermost marker dir, so an @-group skill validates its
      // name against the leaf dir, not the @-group ancestor.
      assertNameMatchesDir(parsedName, leaf.dir);
    } catch (err) {
      errors.push({ kind: leaf.kind, name: leaf.name, message: String(err instanceof Error ? err.message : err) });
    }
  }
}
