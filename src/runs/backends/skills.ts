// Per-Run skill projection into each backend's native progressive-disclosure
// layout (spec §Skills projection). Hive projects bound skills to disk and the
// SDK does its OWN disclosure — Hive runs no disclosure loop (ADR-0016 intent).
// MCP carries TOOLS, not skills; the two stay separate.
//
// Per-agent isolation is preserved by projecting each Run's bound skills into a
// per-Run isolated location — never a shared user-global dir:
//   - Claude: a per-Run Hive-owned plugins dir laid out as `<root>/skills/<name>/`,
//     loaded via `plugins: [{ type: 'local', path: <root> }]` (isolated regardless
//     of cwd).
//   - Codex: `.agents/skills/<name>/` under the workspace cwd (no out-of-tree
//     option — the bound-to-a-repo case degrades; recorded as a known limitation
//     in ADR-0019).
//
// A single skill's copy failure is non-fatal: trace-logged (a copy failure is a
// system diagnostic, not a user/agent action — AGENTS.md) and skipped.

import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../../lib/log.ts";
import type { InvocationSkill } from "./invocation.ts";

// The default FS copy edge: recursive dir copy + recursive remove. Plain async
// around node:fs/promises at the true external boundary.
export type SkillFsCopy = {
  copy(src: string, dest: string): Promise<void>;
  remove(target: string): Promise<void>;
};

export function createDefaultSkillFsCopy(): SkillFsCopy {
  return {
    copy: (src, dest) => cp(src, dest, { recursive: true }),
    remove: (target) => rm(target, { recursive: true, force: true }),
  };
}

// Copy each resolved skill's containing directory into `skillsDir/<name>`.
// Returns true iff at least one skill landed. A per-skill copy failure is
// trace-logged and skipped.
export async function projectSkills(input: {
  skills: readonly InvocationSkill[];
  skillsDir: string;
  copy: SkillFsCopy["copy"];
  runId?: string;
}): Promise<boolean> {
  const { skills, skillsDir, copy, runId } = input;
  if (skills.length === 0) return false;
  let landed = 0;
  for (const skill of skills) {
    const srcDir = dirname(skill.path);
    const dest = join(skillsDir, skill.name);
    try {
      await copy(srcDir, dest);
      landed += 1;
    } catch (err) {
      log().warn(
        { module: "runs/backends/skills", runId, skill: skill.name, err },
        "skipped projecting skill",
      );
    }
  }
  return landed > 0;
}
