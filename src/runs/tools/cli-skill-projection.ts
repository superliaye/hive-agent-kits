// CLI skill projection (C3 / ADR-0016 "projecting spawn, not thin spawn").
//
// Copies each bound, resolved skill's DIRECTORY into a Hive-owned location laid
// out as `<projectionRoot>/.claude/skills/<name>/` so claude-code's own loader
// discloses them via `--add-dir <projectionRoot>`. Hive runs NO N3 disclosure on
// this path — the CLI does its own progressive disclosure.
//
// The location is provably outside the Run's workspace cwd (a sibling under
// `agents/<id>/cli-projection/<runId>/`), so projected skills never pollute the
// repo the Agent is working in (ADR-0016 "no repo pollution").
//
// A single skill's copy failure is non-fatal: it is trace-logged (a copy failure
// is a system diagnostic, not a user/agent action — AGENTS.md audit-vs-trace) and
// skipped; the Run proceeds with whatever skills landed.

import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../../lib/log.ts";
import type { FsCopyPort, ProjectableSkill } from "../effect/ports.ts";

// The default FS copy edge: recursive dir copy + recursive remove. Plain async
// around node:fs/promises, wrapped inward at the executor.
export function createDefaultFsCopy(): FsCopyPort {
  return {
    copy: (src, dest) => cp(src, dest, { recursive: true }),
    remove: (target) => rm(target, { recursive: true, force: true }),
  };
}

export type ProjectSkillsForCliInput = {
  /** The resolved bound skills (misses already dropped by the resolver). */
  skills: readonly ProjectableSkill[];
  /** The `.claude/skills` dir to copy each skill INTO. */
  skillsDir: string;
  /** Recursive dir-copy edge. */
  copy: FsCopyPort["copy"];
  /** The Run id — for trace context only. */
  runId?: string;
};

/**
 * Copy each resolved skill's containing directory into `skillsDir/<name>`.
 *
 * Returns `true` iff at least one skill landed (the caller then adds
 * `--add-dir`); `false` when there are no skills or none copied (no `--add-dir`,
 * no dir written). A per-skill copy failure is trace-logged and skipped.
 */
export async function projectSkillsForCli(input: ProjectSkillsForCliInput): Promise<boolean> {
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
      log().warn({ module: "runs/cli", runId, skill: skill.name, err }, "skipped projecting skill");
    }
  }
  return landed > 0;
}
