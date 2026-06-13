// Tool registry — the extension point N2 (file tools) / N3 (load_skill) add
// entries to. F1 seeds exactly one tracer Tool: `run_shell`.
//
// A ToolHandler pairs the wire `ToolDef` (sent to the model) with a `run` verb
// the loop dispatches. `CompletionInput.tools` is derived by filtering this
// registry by the Agent's `bindings.tools` (Tools are bound Capabilities — the
// CONTEXT-correct model): a registry entry is sent ONLY when its name is in
// `bindings.tools`. This is the exact seam N2 extends for file tools.

import type { AgentId, RunId } from "../../lib/ids.ts";
import type { ToolDef } from "../../model-gateway/types.ts";
import type { FsRunnerPort, ShellRunnerPort, SkillResolverPort } from "../effect/ports.ts";
import { makeEditTool, makeReadTool, makeWriteTool } from "./file-tools.ts";
import { makeLoadSkillTool } from "./load-skill.ts";
import { makeRunShellTool } from "./run-shell.ts";

// What a tool returns, folded into a `tool_result` content block.
// `loadedSkill` surfaces a skill name known only AFTER run() resolves (describe()
// runs pre-dispatch); the executor emits run.skill_loaded from it.
export type ToolResult = { content: string; isError: boolean; loadedSkill?: string };

// Per-call execution context handed to a tool's `run`.
export type ToolContext = {
  agentId: AgentId;
  runId: RunId;
  // The working directory the tool runs in. Resolved once per Run by the
  // executor via resolveWorkingDir()'s three tiers (ADR-0016 C4): Thread pick →
  // agent default → per-Agent ~/.hive workspace. File tools confine to this cwd.
  cwd: string;
  // The Agent's spawn-time bound skill names for this Run. `load_skill` resolves
  // only names in this set — skill loading is scoped to the frozen Harness
  // bindings (CONTEXT.md), not the whole Capability Registry.
  boundSkills: readonly string[];
  // Loop-scoped cancellation. Threaded to the I/O edge so an aborted Run kills
  // in-flight work (e.g. the run_shell child).
  signal: AbortSignal;
};

export type ToolHandler = {
  def: ToolDef;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Projects the tool's input into the gate + audit metadata the executor
   * needs, so the executor never knows a tool's wire shape. `command` is a ref
   * (drives the permission gate); `path` is the model-supplied workspace-relative
   * path (the call's target ref — file tools, same ref treatment as `command`);
   * `argSummary` is
   * count-only and `editSummary` is length-only — both redaction-safe (the
   * handler only DECLARES fields; never values, never file content). Tools with
   * no projection omit this or return {}.
   */
  describe?(input: unknown): {
    command?: string;
    path?: string;
    argSummary?: { count: number };
    editSummary?: { oldLen: number; newLen: number };
  };
};

export type ToolRegistry = ReadonlyMap<string, ToolHandler>;

export type BuildRegistryDeps = {
  shell: ShellRunnerPort;
  fs: FsRunnerPort;
  skills: SkillResolverPort;
};

// Built once per executor. The single place tools are registered — D edits
// only this builder + the tools/ folder.
export function buildToolRegistry(deps: BuildRegistryDeps): ToolRegistry {
  const handlers: ToolHandler[] = [
    makeRunShellTool(deps.shell),
    makeReadTool(deps.fs),
    makeWriteTool(deps.fs),
    makeEditTool(deps.fs),
    makeLoadSkillTool(deps.skills),
  ];
  return new Map(handlers.map((h) => [h.def.name, h]));
}

// Derive the `ToolDef[]` to send for a Run: the registry filtered by the
// Agent's bound tool names. A bound name with no registry entry is skipped
// (not yet implemented). Returns undefined when nothing is bound so the loop
// omits `tools` entirely.
export function toolsForBindings(
  registry: ToolRegistry,
  boundToolNames: readonly string[],
): ToolDef[] | undefined {
  const defs: ToolDef[] = [];
  for (const name of boundToolNames) {
    const handler = registry.get(name);
    if (handler) defs.push(handler.def);
  }
  return defs.length > 0 ? defs : undefined;
}
