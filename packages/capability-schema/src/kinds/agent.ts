// Agent capability schema (ADR-0027). An `AGENT.md` is a folder-kind capability
// isomorphic to skill: it deploys to Claude as raw `AGENT.md`, and its name falls
// back to the directory when omitted. So it shares the folder-kind name contract
// (`./name.ts`): optional `name` with NAME_PATTERN + the reserved-word/XML-char
// guards, plus the name==dir rule (enforced in the validate() gate). A LENIENT
// SUPERSET, strict only on the load-bearing fields: `description` is required and
// non-empty with NO max cap — real agent descriptions run 600+ chars (deploy reads
// `description`, falling back to ""), and length is not load-bearing. Unknown keys
// (`added_in`, etc.) pass through.

import { z } from "zod";
import { NAME_PATTERN, refineName } from "./name.ts";

export const AgentFrontmatter = z
  .object({
    name: z.string().min(1).max(64).regex(NAME_PATTERN).nullish(),
    description: z.string().min(1),
  })
  .passthrough()
  .superRefine(refineName);
export type AgentFrontmatter = z.infer<typeof AgentFrontmatter>;
