// C3 cli-skill-projection: copy bound skill dirs into the Hive-owned
// `<projectionRoot>/.claude/skills/<name>/` location. Misses (absent from the
// resolver output) and per-skill copy failures are skipped without failing;
// empty bindings write nothing and return false.

import { describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { runtime, runtimeRoot } from "../../../lib/paths.ts";
import type { ProjectableSkill } from "../../effect/ports.ts";
import { projectSkillsForCli } from "../cli-skill-projection.ts";
import { resolveWorkingDir } from "../run-shell.ts";

const AGENT = "test-agent";
const RUN = "run-1";

function skill(name: string): ProjectableSkill {
  // The skill's SKILL.md; its containing dir is what gets copied.
  return { name, path: `/bundled/personal/skills/${name}/SKILL.md`, origin: "personal" };
}

describe("projectSkillsForCli", () => {
  test("copies each skill's DIR into <skillsDir>/<name> and returns true", async () => {
    const calls: Array<{ src: string; dest: string }> = [];
    const skillsDir = runtime.projectedCliSkillsDir(AGENT, RUN);

    const landed = await projectSkillsForCli({
      skills: [skill("research"), skill("writing")],
      skillsDir,
      copy: async (src, dest) => {
        calls.push({ src, dest });
      },
      runId: RUN,
    });

    expect(landed).toBe(true);
    expect(calls).toEqual([
      { src: dirname(skill("research").path), dest: join(skillsDir, "research") },
      { src: dirname(skill("writing").path), dest: join(skillsDir, "writing") },
    ]);
  });

  test("destination is under runtimeRoot and never under the workspace cwd", async () => {
    const skillsDir = runtime.projectedCliSkillsDir(AGENT, RUN);
    let dest = "";
    await projectSkillsForCli({
      skills: [skill("research")],
      skillsDir,
      copy: async (_src, d) => {
        dest = d;
      },
    });

    // Hive-owned location under runtimeRoot, laid out as .claude/skills/<name>.
    expect(dest.startsWith(runtimeRoot())).toBe(true);
    expect(skillsDir.endsWith(join(".claude", "skills"))).toBe(true);

    // Provably outside the Agent's workspace cwd — the relative path escapes.
    const cwd = resolveWorkingDir({ agentId: AGENT });
    const rel = relative(cwd, dest);
    expect(rel.startsWith("..")).toBe(true);
  });

  test("a copy that throws is skipped without failing; survivors still land", async () => {
    const landedNames: string[] = [];
    const skillsDir = runtime.projectedCliSkillsDir(AGENT, RUN);

    const landed = await projectSkillsForCli({
      skills: [skill("bad"), skill("good")],
      skillsDir,
      copy: async (src) => {
        if (src.endsWith("/bad")) throw new Error("EACCES");
        landedNames.push(src);
      },
      runId: RUN,
    });

    // The good skill landed; the throwing one was skipped, so the projector
    // still reports a usable projection.
    expect(landed).toBe(true);
    expect(landedNames).toEqual([dirname(skill("good").path)]);
  });

  test("all copies failing → returns false (no usable projection)", async () => {
    const landed = await projectSkillsForCli({
      skills: [skill("a"), skill("b")],
      skillsDir: runtime.projectedCliSkillsDir(AGENT, RUN),
      copy: async () => {
        throw new Error("boom");
      },
    });
    expect(landed).toBe(false);
  });

  test("empty skills → returns false and never calls copy", async () => {
    let copied = false;
    const landed = await projectSkillsForCli({
      skills: [],
      skillsDir: runtime.projectedCliSkillsDir(AGENT, RUN),
      copy: async () => {
        copied = true;
      },
    });
    expect(landed).toBe(false);
    expect(copied).toBe(false);
  });
});
