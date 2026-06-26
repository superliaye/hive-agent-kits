// Instruction capability schema (ADR-0028). An `<name>.instructions.md` is a
// file-kind capability: its name comes from the filename, so there is no `name`
// field and no name==dir rule. At deploy the frontmatter is STRIPPED and the body
// concatenated into `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` — nothing in the
// frontmatter is load-bearing. So this is the minimal strict floor: `description`
// required and non-empty (the consistent, demonstrable malformed→fail case;
// consistent with every other kind). Everything else (`applyTo`, `added_in`,
// `derived_from`, `synced`, …) rides through `.passthrough()` unconstrained.

import { z } from "zod";

export const InstructionFrontmatter = z
  .object({
    description: z.string().min(1),
  })
  .passthrough();
export type InstructionFrontmatter = z.infer<typeof InstructionFrontmatter>;
