// Skills capability schema — the Agent Skills open standard (`SKILL.md`
// frontmatter, agentskills.io/specification), referenced rather than reinvented,
// plus Anthropic's documented refinements. A LENIENT SUPERSET of the standard,
// matching what the Claude Code CLI actually accepts (ADR-0024): `description` is
// the only required field; `name` is optional or null — omitted or left blank, the
// effective name is the directory (per the runtime); unknown keys pass through
// (preserved, not stripped); `metadata` values are unconstrained. The name-quality
// guards (regex, reserved-word, XML-char) still apply to a PRESENT name — a declared
// name that the CLI would reject is a robustness gap — but an absent/blank name is
// NOT re-validated against them; the directory is trusted as the effective name.

import { z } from "zod";

// `name`: 1-64 chars, lowercase alnum + single hyphens, no leading/trailing/
// consecutive hyphen.
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SkillFrontmatter = z
  .object({
    // `.nullish()`: a bare `name:` (YAML null) is "left blank" — treated like an
    // omitted name (defer to the directory), matching the runtime, not an error.
    name: z.string().min(1).max(64).regex(NAME_PATTERN).nullish(),
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Hyphenated key, space-separated string. Experimental in the standard.
    "allowed-tools": z.string().optional(),
  })
  .passthrough()
  // Anthropic refinements over a PRESENT name: reject XML-tag characters and the
  // reserved words `anthropic`/`claude` (case-insensitive substring) early. Guarded
  // on a present name — an omitted name defers to the directory and is not refined.
  .superRefine((value, ctx) => {
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
  });
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

// The "name == parent directory" rule is a separate pure validator: frontmatter
// alone can't know its directory; the daemon's fs adapter supplies it (#28/#31).
// Throws on mismatch so callers in the typed-error daemon can map it.
export function assertNameMatchesDir(name: string, dirName: string): void {
  if (name !== dirName) {
    throw new Error(`skill name "${name}" must match its parent directory "${dirName}"`);
  }
}
