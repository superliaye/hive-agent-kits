// Codex's per-Run skill-projection LAYOUT (ADR-0019). Codex discloses skills
// from `.agents/skills/<name>/` under the workspace cwd — there is no out-of-tree
// plugins option, so it returns no plugin path. The bound-to-a-repo case degrades
// (known limitation, ADR-0019). Cleanup is a no-op: the projection lives inside
// the user's workspace, not a Hive-owned per-Run dir (only Claude cleans up).

import { join } from "node:path";
import type { BackendInvocation } from "../invocation.ts";
import { projectSkills, type SkillFsCopy, type SkillProjector } from "../skills.ts";

export type CodexSkillProjectorDeps = {
  copy: SkillFsCopy;
};

export function createCodexSkillProjector(deps: CodexSkillProjectorDeps): SkillProjector {
  return {
    async project(invocation: BackendInvocation): Promise<{ pluginPath?: string }> {
      if (invocation.skills.length === 0) return {};
      await projectSkills({
        skills: invocation.skills,
        skillsDir: join(invocation.cwd, ".agents", "skills"),
        copy: deps.copy.copy,
        runId: invocation.runId,
      });
      return {};
    },
    cleanup(): void {},
  };
}
