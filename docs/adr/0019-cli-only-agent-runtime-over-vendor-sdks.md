# CLI-only agent runtime over raw vendor Agent SDKs

---
status: Superseded by ADR-0021
supersedes: ADR-0005, ADR-0010, ADR-0016, ADR-0017
supersedes-in-part: ADR-0015
resolves: ADR-0018
---

## What this records

Hive's Run runtime is now **one deep module that drives the vendor Agent SDKs
directly** — `@anthropic-ai/claude-agent-sdk` (`claude-code`) and
`@openai/codex-sdk` (`codex`) — behind the unchanged Run seam
`startRun(thread, agent) → AsyncIterable<RunEvent>` ([CONTEXT.md](../../CONTEXT.md)).
The **native in-process tool-loop, the ModelGateway, and pi-ai (both as the LLM
completion transport AND as the OAuth-login + model-catalog source) are
deleted**; the **Permission module is deleted** (governance deliberately
deferred); **Audit is kept** (its emitter relocates to the SDK adapters). v1
ships **both** backends.

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
- **Auth is API keys OR ambient CLI login — no in-app OAuth.** Auth resolves from
  the Secrets module (`SecretsPort.getAuth`) as `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`; when no Hive Secret resolves, the SDK falls back to its own
  ambient OS login (`~/.claude` from `claude login`, `~/.codex/auth.json` from
  `codex login`). The in-app subscription-OAuth login flow is **deleted**. The
  adapters spread `process.env` and set the API-key var only when a Secret is
  present, so an empty value never clobbers an ambient login.
- **Keep model selection in Hive (ADR-0015 partial); static catalog.** Hive still
  resolves model + effort and passes them to the SDK. The *catalog source* is now a
  **static per-backend model list** (no `ModelGateway.listModels`, no live registry),
  filtered to the providers a backend exists for. The tiered resolver SHAPE is
  unchanged.
- **pi-ai is fully removed.** It is gone as the LLM completion transport AND as the
  OAuth-login + model-catalog source; `@earendil-works/pi-ai` is dropped from
  dependencies entirely.
- **Continuity is SDK-native session resume only.** The sole continuity mechanism
  is each backend's own session resume: only the latest user message crosses the
  Run seam; Hive never re-projects prior turns. Create-vs-resume is decided at
  message-send time by comparing the resolved backend to the Thread's STORED CLI
  session backend, and the stored backend is updated only when a Run actually
  executes. So switch-without-send and switch-back-before-send are **no-ops**;
  switching backend and then sending starts that backend's session **fresh**
  (accepted, silent) — the prior history is not replayed into it.
- **`invoke_capability` reports unrunnable honestly.** A capability found in the
  Registry but with no in-process tool runner to execute it returns
  `{ isError: true }` (`"cannot run: no in-process tool runtime"`), not a false
  success. The missing in-process tool runner is an explicit follow-up.

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
  Memory tool is a stub this iteration, and `invoke_capability` reports unrunnable
  until an in-process tool runner lands (both follow-ups).
- pi-ai is removed entirely — no completion transport, no OAuth login, no model
  registry; auth is API keys in Secrets or ambient CLI login, the catalog is static.
- ADR-0005 (ModelGateway), ADR-0010 (pi-ai transport), ADR-0016 (CLI projecting
  spawn), and ADR-0017 (native tool-calling loop) are superseded; ADR-0015 is
  superseded in part (catalog source); ADR-0018's AM native-lock is resolved by full
  carve-out removal.
