# CLI-only agent runtime over raw vendor Agent SDKs

---
status: accepted
supersedes: ADR-0005, ADR-0010, ADR-0016, ADR-0017
supersedes-in-part: ADR-0015
resolves: ADR-0018
---

## What this records

Hive's Run runtime is now **one deep module that drives the vendor Agent SDKs
directly** — `@anthropic-ai/claude-agent-sdk` (`claude-code`) and
`@openai/codex-sdk` (`codex`) — behind the unchanged Run seam
`startRun(thread, agent) → AsyncIterable<RunEvent>` ([CONTEXT.md](../../CONTEXT.md)).
The **native in-process tool-loop, the ModelGateway, and pi-ai as the LLM
completion transport are deleted**; the **Permission module is deleted**
(governance deliberately deferred); **Audit is kept** (its emitter relocates to
the SDK adapters). v1 ships **both** backends.

Full design + locked decisions D1-D6: [the vendor-SDK CLI-backends
design](../superpowers/specs/2026-06-15-vendor-sdk-cli-backends-design.md).

## Decisions (locked)

- **Reject the Vercel `HarnessAgent` pivot.** `@ai-sdk/harness-claude-code`/`-codex`
  require a port-exposing sandbox; the only one shipping is `@ai-sdk/sandbox-vercel`
  (cloud). So claude-code/codex under HarnessAgent execute in a **remote cloud
  sandbox** — incompatible with Hive's local-Daemon premise — and governance
  collapses to a coarse allow/deny. Use the **raw vendor Agent SDKs** instead: they
  run locally, keep model choice in Hive, and expose richer hooks.
- **Drop the native backend.** The `AgentBackend` enum is now `claude-code | codex`
  (no `native`). The ~700-line in-process tool-loop, the native built-in tools
  (`run_shell`/`read`/`write`/`edit`/`load_skill`), the raw-binary CLI spawn, and the
  ModelGateway+Provider-Adapter stack are all deleted. Each SDK runs its **own** tool
  loop and progressive disclosure; Hive runs none.
- **Defer governance (delete Permission).** Claude:
  `permissionMode: 'bypassPermissions'` AND `allowDangerouslySkipPermissions: true`
  (both required). Codex: `approvalPolicy: 'never'` + `sandboxMode: 'workspace-write'`
  (the sandbox is the only boundary). The re-add door stays cheap: Claude's
  `canUseTool` hook and Codex's app-server layer both exist; a future Permission
  module wires into the adapter without reshaping it.
- **Skills native-to-SDK; MCP reserved for tools.** Hive projects each Run's bound
  Skills to a **per-Run isolated** location (Claude: a Hive-owned `plugins` dir;
  Codex: `.agents/skills` under the workspace cwd) and the SDK does its own
  disclosure. Hive's own domain capabilities (Memory, capability invocation,
  Agent-Manager lifecycle) are exposed as **one MCP server** on the daemon that both
  backends connect to by URL — the single "author tools once" boundary, and the
  common denominator (Codex accepts only MCP servers, not in-process tools).
- **Auth defaults to API keys.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, resolved
  from the surviving Secrets module (`SecretsPort.getAuth`); subscription OAuth
  (`CLAUDE_CODE_OAUTH_TOKEN`, `codex login`) is a personal-dev path honored when
  present but not the product default. When no Hive secret resolves the SDK falls
  back to its own ambient login.
- **Keep model selection in Hive (ADR-0015 partial).** Hive still resolves model +
  effort and passes them to the SDK. What changes is the *catalog source*: there is
  no `ModelGateway.listModels` — the runnable list is derived per backend from
  pi-ai's model registry ∩ credentialed providers. The tiered resolver SHAPE is
  unchanged.
- **Keep `@earendil-works/pi-ai` as a package.** It is deleted only as the LLM
  *completion transport*; the Secrets module still imports its OAuth surface
  (`@earendil-works/pi-ai/oauth`) for subscription login, and the model catalog uses
  its model registry for enumeration.

## Resolves ADR-0018 (the agent-manager native-lock)

ADR-0018 retained an always-native lock on the **Agent Manager** because its
lifecycle built-ins (`create_agent`, `update_agent_harness`, `destroy_agent`) were
in-process tools a CLI could not invoke. With native gone there is nothing to
neutralize to, and those built-ins are now **MCP tools on the capability server** —
so the AM invokes them like any other agent over MCP. The carve-out is **removed
entirely**: `backendAllowedForAgent` (`catalog/role.ts`), the neutralize-to-native
fold (`resolve.ts`), and the route 409 guards (`routes.ts`) are deleted; the bundled
agent-manager Harness backend is no longer `native`. The Agent Manager runs on
whichever CLI/SDK backend its Harness/prefs resolve to. This is the deferred "C6"
arriving for free.

## Audit rewiring (Audit kept, ADR-0004)

- **Retired** (native-path emitters, deleted with native):
  `run.tool_use.requested`/`.executed`, `run.skill_loaded`, and the entire
  `permission` source (`permission.requested`/`.decided`).
- **Kept, emitted from the SDK adapters:** Run lifecycle
  (`run.started`/`completed`/`failed`/`cancelled`) and `backend.tool_use.observed`
  (folded from Claude `tool_use` / Codex `command_execution`+`file_change`+
  `mcp_tool_call`). REFS only — tool name + `isError`.
- **Repurposed:** `backend.spawn.requested` → `backend.run.started` (backend kind +
  resolved model; the SDK owns argv now, so there is no binary/args to record).
  Audit becomes observation-without-enforcement — coherent with deleting Permission.

## Known limitation — Codex repo-bound skills

Codex has no out-of-tree skills option, so per-Run isolation comes from `cwd`. In
the **default** case (`cwd` = the agent's `~/.hive` workspace) projection to
`.agents/skills` is clean and isolated. In the explicit **bound-to-a-repo** case
(`cwd` = a user repo) Hive's portable skills cannot be added out-of-tree without
polluting the repo or colliding across concurrent same-repo agents — isolation
degrades. This is a user-chosen mode; the repo stays reachable for file work via
`additionalDirectories`. Claude does not have this limitation (it loads skills from
an isolated `plugins` dir regardless of `cwd`).

## The bet, and when to revisit

The bet is that the raw vendor SDKs — local, model-in-Hive's-hands, richer hooks —
are the right substrate for a portable personal Daemon, and that paying the
governance tax per feature is premature before the project earns usage. Revisit
when: usage justifies re-adding a Permission module (wire `canUseTool` / the Codex
app-server into the adapter); a third backend or cross-vendor model-swap ships; or
the Memory subsystem lands (today the MCP `memory_read` tool is a non-functional
stub proving the seam, not a store).

## Consequences

- One module, two backends, behind the unchanged streaming Run seam; both run
  locally and were phase-0 smoke-confirmed to spawn + complete a turn under Bun.
- No native backend, no ModelGateway, no Provider Adapter, no Permission module, no
  native built-in tools, no raw-binary CLI spawn.
- The capability MCP server is the single place Hive authors domain tools; the
  Memory tool is a stub this iteration (the full Memory subsystem is a follow-up).
- pi-ai survives as a dependency for Secrets OAuth + the model catalog source, never
  as the completion transport.
- ADR-0005 (ModelGateway), ADR-0010 (pi-ai transport), ADR-0016 (CLI projecting
  spawn), and ADR-0017 (native tool-calling loop) are superseded; ADR-0015 is
  superseded in part (catalog source); ADR-0018's AM native-lock is resolved by full
  carve-out removal.
