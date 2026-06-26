// Skills capability schema — the Agent Skills open standard (`SKILL.md`
// frontmatter, agentskills.io/specification), referenced rather than reinvented,
// plus Anthropic's documented refinements. A LENIENT SUPERSET of the standard,
// matching what the Claude Code CLI actually accepts (ADR-0024): `description` is
// the only required field; `name` is optional or null — omitted or left blank, the
// effective name is the directory (per the runtime); unknown keys pass through
// (preserved, not stripped); `metadata` values are unconstrained. The name-quality
// guards (regex, reserved-word, XML-char) and the name==dir rule are the shared
// folder-kind name contract (`./name.ts`), reused here and by `agent`.

import { z } from "zod";
import { nameField, refineName } from "./name.ts";

export const SkillFrontmatter = z
  .object({
    // Shared folder-kind name field (`nameField`): optional/nullish — a bare
    // `name:` (YAML null) is "left blank", treated like an omitted name (defer to
    // the directory), matching the runtime, not an error.
    name: nameField,
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Hyphenated key, space-separated string. Experimental in the standard.
    "allowed-tools": z.string().optional(),
  })
  .passthrough()
  .superRefine(refineName);
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;
