// Build the codex-sdk options for a Run (spec §Codex adapter, verified against
// @openai/codex-sdk@0.140.0). Pure (no I/O) so it is unit-testable.
//
// Codex accepts NO in-process tools — only MCP servers, configured via the CLI
// `--config` overrides (CodexOptions.config). So the Hive capability MCP server
// is wired through `config.mcp_servers.<name>.url`, and the instruction blob
// rides `config.developer_instructions` (Codex has no typed systemPrompt).
// Governance is deferred: approvalPolicy:'never' + sandboxMode:'workspace-write'.

import type { CodexOptions, ModelReasoningEffort, ThreadOptions } from "@openai/codex-sdk";
import type { ThinkingEffort } from "../../../lib/effort.ts";
import { CAPABILITY_MCP_SERVER_NAME } from "../capabilities-mcp.ts";
import type { BackendInvocation } from "../invocation.ts";

// Codex's reasoning-effort set excludes "off" (the lowest is "minimal"). Map a
// Hive ThinkingEffort onto it; "off" has no Codex equivalent → omit the knob.
export function codexReasoningEffort(effort: ThinkingEffort): ModelReasoningEffort | undefined {
  switch (effort) {
    case "off":
      return undefined;
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
  }
}

// Codex's `model` wants the bare model id (no `provider/` prefix), like Claude.
export function bareModelId(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export type BuiltCodexOptions = {
  codex: CodexOptions;
  thread: ThreadOptions;
};

// CodexOptions.config is a recursive TOML-ish value tree (CodexConfigObject) the
// SDK flattens to `--config` overrides. The type isn't exported; derive it off
// CodexOptions so we stay in lock-step with the SDK.
type CodexConfig = NonNullable<CodexOptions["config"]>;

export function buildCodexOptions(invocation: BackendInvocation): BuiltCodexOptions {
  const { systemPrompt, cwd, model, effort, auth, mcpEndpoint } = invocation;

  // The Hive capability MCP server + the instruction blob ride `--config`.
  const config: CodexConfig = {
    mcp_servers: {
      [CAPABILITY_MCP_SERVER_NAME]: { url: mcpEndpoint },
    },
    ...(systemPrompt.trim().length > 0 ? { developer_instructions: systemPrompt } : {}),
  };

  const codex: CodexOptions = {
    config,
    ...(auth?.kind === "apiKey" ? { apiKey: auth.apiKey } : {}),
  };

  const reasoning = effort !== undefined ? codexReasoningEffort(effort) : undefined;
  const thread: ThreadOptions = {
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    model: bareModelId(model),
    ...(reasoning !== undefined ? { modelReasoningEffort: reasoning } : {}),
  };

  return { codex, thread };
}
