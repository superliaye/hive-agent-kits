// Skills capability schema — the Agent Skills open standard (`SKILL.md`
// frontmatter, agentskills.io/specification), referenced rather than reinvented,
// plus Anthropic's documented refinements. This package is the anti-corruption
// layer over external Source repos: `.strict()` + Anthropic fidelity reject
// content the Claude Code CLI would reject, early (ADR-0024).

import { z } from "zod";

// `name`: 1-64 chars, lowercase alnum + single hyphens, no leading/trailing/
// consecutive hyphen.
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SkillFrontmatter = z
  .object({
    name: z.string().min(1).max(64).regex(NAME_PATTERN),
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    // Hyphenated key, space-separated string. Experimental in the standard.
    "allowed-tools": z.string().optional(),
  })
  .strict()
  // Anthropic refinements: a `name` that passes the open standard but the Claude
  // Code CLI rejects is a robustness gap (a Source that passes Hive but fails the
  // CLI). Reject XML-tag characters and the reserved words `anthropic`/`claude`
  // (case-insensitive substring) early.
  .superRefine((value, ctx) => {
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
