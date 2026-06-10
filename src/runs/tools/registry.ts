// Tool registry — the extension point N2 (file tools) / N3 (load_skill) add
// entries to. F1 seeds exactly one tracer Tool: `run_shell`.
//
// A ToolHandler pairs the wire `ToolDef` (sent to the model) with a `run` verb
// the loop dispatches. `CompletionInput.tools` is derived by filtering this
// registry by the Agent's `bindings.tools` (Tools are bound Capabilities — the
// CONTEXT-correct model): a registry entry is sent ONLY when its name is in
// `bindings.tools`. This is the exact seam N2 extends for file tools.

import type { ToolDef } from "../../model-gateway/types.ts";
import type { ShellRunnerPort } from "../effect/ports.ts";
import { makeRunShellTool } from "./run-shell.ts";

// What a tool returns, folded into a `tool_result` content block.
export type ToolResult = { content: string; isError: boolean };

// Per-call execution context handed to a tool's `run`.
export type ToolContext = {
  agentId: string;
  runId: string;
  // The working directory the tool runs in. F1 defaults this via
  // resolveWorkingDir(); F/C4 owns the three-tier Working Directory resolution.
  cwd: string;
};

export type ToolHandler = {
  def: ToolDef;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
};

export type ToolRegistry = ReadonlyMap<string, ToolHandler>;

export type BuildRegistryDeps = {
  shell: ShellRunnerPort;
};

// Built once per executor. The single place tools are registered — D edits
// only this builder + the tools/ folder.
export function buildToolRegistry(deps: BuildRegistryDeps): ToolRegistry {
  const handlers: ToolHandler[] = [makeRunShellTool(deps.shell)];
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
