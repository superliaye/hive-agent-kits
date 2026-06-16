// Build the claude-agent-sdk `Options` for a Run (spec §Claude adapter). Pure
// (no I/O) so it is unit-testable: a BackendInvocation in, an Options object out.
//
// Governance is deferred (no Permission module): the bypass PAIR
// (`permissionMode: 'bypassPermissions'` AND `allowDangerouslySkipPermissions:
// true`) is required — `'dontAsk'` is wrong (it denies non-preapproved tools).
// Capabilities ride the Hive MCP server (mcpServers + pre-approved
// `mcp__hive__*`); skills ride a per-Run `plugins` dir (isolated regardless of
// cwd) while `settingSources:['project']` + `skills:'all'` still compose a repo's
// own committed `.claude/skills` when cwd = repo.

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { CAPABILITY_MCP_SERVER_NAME } from "../capabilities-mcp.ts";
import type { BackendInvocation } from "../invocation.ts";

// Claude's `--model` is anthropic-only and wants the bare model id (no
// `provider/` prefix). Hive resolves `provider/model`; strip the provider here.
export function bareModelId(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export type BuildClaudeOptionsInput = {
  invocation: BackendInvocation;
  /** The per-Run plugins dir holding the projected bound skills (when any). */
  pluginPath?: string;
  /** Escape hatch from Phase 0 (Bun spawn failure). Default: spawn under Bun. */
  pathToClaudeCodeExecutable?: string;
};

export function buildClaudeOptions(input: BuildClaudeOptionsInput): Options {
  const { invocation, pluginPath, pathToClaudeCodeExecutable } = input;
  const { systemPrompt, cwd, model, provider, effort, auth, mode, mcpEndpoint } = invocation;

  // env REPLACES the subprocess env, so spread process.env and overlay the key.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (auth?.kind === "apiKey") env.ANTHROPIC_API_KEY = auth.apiKey;

  const options: Options = {
    executable: "bun",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    cwd,
    env,
    settingSources: ["project"],
    skills: "all",
    mcpServers: {
      [CAPABILITY_MCP_SERVER_NAME]: { type: "http", url: mcpEndpoint },
    },
    // Pre-approve every Hive capability tool so the bypassed run can call them.
    allowedTools: [`mcp__${CAPABILITY_MCP_SERVER_NAME}__*`],
    ...(systemPrompt.trim().length > 0 ? { systemPrompt } : {}),
    // `--model` is forwarded only for anthropic (Claude's own provider).
    ...(provider === "anthropic" ? { model: bareModelId(model) } : {}),
    ...(pluginPath !== undefined ? { plugins: [{ type: "local", path: pluginPath }] } : {}),
    ...(mode.kind === "resume" ? { resume: mode.sessionId } : {}),
    ...(pathToClaudeCodeExecutable !== undefined ? { pathToClaudeCodeExecutable } : {}),
  };

  // Claude has no typed thinking-effort knob on Options; effort is reserved for a
  // later mapping (e.g. a model alias). Captured here so the field is not lost.
  void effort;

  return options;
}
