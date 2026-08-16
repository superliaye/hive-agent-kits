// Shared folder-kind name contract (ADR-0024). `skill` and `agent` are
// isomorphic folder kinds: both deploy under a directory whose name is the
// effective capability name, and both accept a lenient superset where `name` is
// optional — omitted or blank, the directory is trusted as the effective name.
// The name regex, the CLI-rejection guards (XML-char, reserved words), and the
// name==dir rule are the SAME contract for both, so they live here once rather
// than duplicated per kind (the DRY argument that justifies the parametrized
// `kind` label applies equally to the regex and the guards — they must not drift).

import { z } from "zod";
import type { CapabilityKind } from "../identity.ts";

// `name`: 1-64 chars, lowercase alnum + single hyphens, no leading/trailing/
// consecutive hyphen.
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The shared `name` FIELD for folder kinds — the full contract, bounds included,
// not just the regex: optional/nullish (omitted or blank `name:` → defer to the
// directory), 1-64 chars, NAME_PATTERN. Reused verbatim by skill and agent so the
// bounds can't drift between them. `.superRefine(refineName)` is applied per kind
// on the assembled object, since refinements attach to the object, not the field.
export const nameField = z.string().min(1).max(64).regex(NAME_PATTERN).nullish();

// Anthropic refinements over a PRESENT name: reject XML-tag characters and the
// reserved words `anthropic`/`claude` (case-insensitive substring) early. Guarded
// on a present name — an omitted/blank name defers to the directory and is not
// refined. Reusable as a `.superRefine` body for any folder kind's frontmatter.
export function refineName(value: { name?: unknown }, ctx: z.RefinementCtx): void {
  if (typeof value.name !== "string") return;
  // Belt-and-suspenders: NAME_PATTERN already excludes `<`/`>`, but this guard
  // keeps the Anthropic XML-tag rule explicit and survives a future loosening
  // of NAME_PATTERN.
  if (/[<>]/.test(value.name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "name must not contain XML-tag characters (< or >)",
    });
  }
  const lower = value.name.toLowerCase();
  if (lower.includes("anthropic") || lower.includes("claude")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: 'name must not contain the reserved words "anthropic" or "claude"',
    });
  }
}

// The "name == parent directory" rule is a separate pure validator: frontmatter
// alone can't know its directory; the daemon's fs adapter supplies it.
// Throws on mismatch so callers in the typed-error daemon can map it. `kind` is a
// required CapabilityKind label so the message names the offending kind, and the
// label can't drift from the real kind set.
export function assertNameMatchesDir(name: string, dirName: string, kind: CapabilityKind): void {
  if (name !== dirName) {
    throw new Error(`${kind} name "${name}" must match its parent directory "${dirName}"`);
  }
}
