// Shared folder-kind name contract (ADR-0024). `skill` and `agent` are
// isomorphic folder kinds: both deploy under a directory whose name is the
// effective capability name, and both accept a lenient superset where `name` is
// optional — omitted or blank, the directory is trusted as the effective name.
// The name regex, the CLI-rejection guards (XML-char, reserved words), and the
// name==dir rule are the SAME contract for both, so they live here once rather
// than duplicated per kind (the DRY argument that justifies the parametrized
// `kind` label applies equally to the regex and the guards — they must not drift).

import { z } from "zod";

// `name`: 1-64 chars, lowercase alnum + single hyphens, no leading/trailing/
// consecutive hyphen.
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
// alone can't know its directory; the daemon's fs adapter supplies it (#28/#31).
// Throws on mismatch so callers in the typed-error daemon can map it. `kind` is a
// required label so the message names the offending kind ("skill"/"agent").
export function assertNameMatchesDir(name: string, dirName: string, kind: string): void {
  if (name !== dirName) {
    throw new Error(`${kind} name "${name}" must match its parent directory "${dirName}"`);
  }
}
