// Claude's per-Run skill-projection LAYOUT (ADR-0019). Bound skills land in a
// Hive-owned, per-Run isolated `plugins` root (`<root>/skills/<name>/`), loaded
// via Claude's `plugins:[{type:'local',path:<root>}]` — isolated regardless of
// cwd. The plugin path is returned ONLY when at least one skill actually landed
// (`landed ? root : undefined`); a zero-skill or all-failed projection yields no
// plugins entry so the SDK isn't pointed at an empty dir.

import type { BackendInvocation } from "../invocation.ts";
import { projectSkills, type SkillFsCopy, type SkillProjector } from "../skills.ts";

// The runtime paths Claude's projection needs: the isolated plugin root and the
// skills subdir beneath it, both keyed by (agentId, runId).
export type ClaudeSkillPaths = {
  pluginRoot(agentId: string, runId: string): string;
  pluginSkillsDir(agentId: string, runId: string): string;
};

export type ClaudeSkillProjectorDeps = {
  copy: SkillFsCopy;
  paths: ClaudeSkillPaths;
};

export function createClaudeSkillProjector(deps: ClaudeSkillProjectorDeps): SkillProjector {
  return {
    async project(invocation: BackendInvocation): Promise<{ pluginPath?: string }> {
      if (invocation.skills.length === 0) return {};
      const root = deps.paths.pluginRoot(invocation.agentId, invocation.runId);
      const skillsDir = deps.paths.pluginSkillsDir(invocation.agentId, invocation.runId);
      const landed = await projectSkills({
        skills: invocation.skills,
        skillsDir,
        copy: deps.copy.copy,
        runId: invocation.runId,
      });
      // Load-bearing: point Claude at the plugins root ONLY when a skill landed.
      return landed ? { pluginPath: root } : {};
    },
    cleanup(invocation: BackendInvocation): void {
      if (invocation.skills.length === 0) return;
      const root = deps.paths.pluginRoot(invocation.agentId, invocation.runId);
      deps.copy.remove(root).catch(() => {});
    },
  };
}
