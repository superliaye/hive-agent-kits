import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { AgentId, RunId, ThreadId } from "../../../lib/ids.ts";
import { createClaudeSkillProjector } from "../claude/skill-projector.ts";
import { createCodexSkillProjector } from "../codex/skill-projector.ts";
import type { BackendInvocation, InvocationSkill } from "../invocation.ts";
import type { SkillFsCopy } from "../skills.ts";

function invocation(skills: InvocationSkill[], cwd = "/work"): BackendInvocation {
  return {
    runId: RunId.parse(crypto.randomUUID()),
    threadId: ThreadId.parse(crypto.randomUUID()),
    agentId: AgentId.parse("worker"),
    backend: "claude-code",
    userMessage: [{ type: "text", text: "hi" }],
    systemPrompt: "",
    cwd,
    model: "anthropic/claude-opus-4-7",
    provider: "anthropic",
    skills,
    mode: { kind: "create" },
    mcpEndpoint: "http://127.0.0.1:3117/mcp",
    signal: new AbortController().signal,
    callbacks: { persistSession: () => {}, onToolObserved: () => {} },
  };
}

function skill(name: string): InvocationSkill {
  return { name, path: `/skills/${name}/SKILL.md`, origin: "personal" };
}

// A recording fs-copy double: `copy` records calls (and may be made to throw);
// `remove` records removals.
function fakeCopy(opts: { failAll?: boolean } = {}): SkillFsCopy & {
  copies: Array<{ src: string; dest: string }>;
  removes: string[];
} {
  const copies: Array<{ src: string; dest: string }> = [];
  const removes: string[] = [];
  return {
    copies,
    removes,
    copy: async (src, dest) => {
      copies.push({ src, dest });
      if (opts.failAll) throw new Error("copy failed");
    },
    remove: async (target) => {
      removes.push(target);
    },
  };
}

const paths = {
  pluginRoot: (agentId: string, runId: string) => `/runtime/${agentId}/${runId}`,
  pluginSkillsDir: (agentId: string, runId: string) => `/runtime/${agentId}/${runId}/skills`,
};

describe("Claude SkillProjector — isolated plugins root + landed?root:undefined", () => {
  test("no bound skills → no plugin path, no copy", async () => {
    const copy = fakeCopy();
    const projector = createClaudeSkillProjector({ copy, paths });
    const result = await projector.project(invocation([]));
    expect(result.pluginPath).toBeUndefined();
    expect(copy.copies).toHaveLength(0);
  });

  test("a skill that lands → returns the isolated plugin root", async () => {
    const copy = fakeCopy();
    const projector = createClaudeSkillProjector({ copy, paths });
    const inv = invocation([skill("diagnose")]);
    const result = await projector.project(inv);
    expect(result.pluginPath).toBe(`/runtime/${inv.agentId}/${inv.runId}`);
    // Copied into the skills subdir under the plugin root. `projectSkills` uses
    // path.dirname for src and path.join for dest, so build the expected paths
    // the same way (OS-agnostic).
    expect(copy.copies).toEqual([
      {
        src: dirname("/skills/diagnose/SKILL.md"),
        dest: join(`/runtime/${inv.agentId}/${inv.runId}/skills`, "diagnose"),
      },
    ]);
  });

  test("all skills fail to land → no plugin path (landed ? root : undefined)", async () => {
    const copy = fakeCopy({ failAll: true });
    const projector = createClaudeSkillProjector({ copy, paths });
    const result = await projector.project(invocation([skill("diagnose")]));
    expect(result.pluginPath).toBeUndefined();
  });

  test("cleanup removes the plugin root when skills were bound", () => {
    const copy = fakeCopy();
    const projector = createClaudeSkillProjector({ copy, paths });
    const inv = invocation([skill("diagnose")]);
    projector.cleanup(inv);
    expect(copy.removes).toEqual([`/runtime/${inv.agentId}/${inv.runId}`]);
  });

  test("cleanup is a no-op when no skills were bound", () => {
    const copy = fakeCopy();
    const projector = createClaudeSkillProjector({ copy, paths });
    projector.cleanup(invocation([]));
    expect(copy.removes).toHaveLength(0);
  });
});

describe("Codex SkillProjector — .agents/skills under cwd, no plugin path", () => {
  test("no bound skills → no plugin path, no copy", async () => {
    const copy = fakeCopy();
    const projector = createCodexSkillProjector({ copy });
    const result = await projector.project(invocation([]));
    expect(result.pluginPath).toBeUndefined();
    expect(copy.copies).toHaveLength(0);
  });

  test("projects into .agents/skills under the workspace cwd; never a plugin path", async () => {
    const copy = fakeCopy();
    const projector = createCodexSkillProjector({ copy });
    const result = await projector.project(invocation([skill("diagnose")], "/repo"));
    expect(result.pluginPath).toBeUndefined();
    expect(copy.copies).toEqual([
      { src: dirname("/skills/diagnose/SKILL.md"), dest: join("/repo/.agents/skills", "diagnose") },
    ]);
  });

  test("cleanup is a no-op (projection lives in the user workspace)", () => {
    const copy = fakeCopy();
    const projector = createCodexSkillProjector({ copy });
    projector.cleanup(invocation([skill("diagnose")]));
    expect(copy.removes).toHaveLength(0);
  });
});
