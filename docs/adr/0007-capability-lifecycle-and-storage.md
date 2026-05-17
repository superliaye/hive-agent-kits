# Capability Lifecycle and Storage

## What this ADR records

How **Capabilities** live, get installed, get updated, and get configured per-Agent in Hive v1. Amends ADR-0003 on four axes: storage layout (now a two-tier bundled-vs-runtime split with parallel Personal/Workplace inside bundled), CLI surface (drops `hive caps install`), Agent Harness mutability (Settings UI edits bindings live), and name resolution rules. Also sharpens ADR-0003's "five Capability kinds" — **Agent Harness is not a Capability**; it's the on-disk artifact of an Agent, indexed in the **Agent Catalog**, not the **Capability Registry**.

## The four Capability kinds

Hive recognizes four Capability kinds. Agent Harness is removed from this list; see "Agent Harness is not a Capability" below.

| Kind | Content | Authored by | Consumed by |
|---|---|---|---|
| **Skill** | Markdown technique file | Maintainer (bundled) or user (runtime) | Running Agent, mid-Run via `load_skill(name)` |
| **Prompt Snippet** | Markdown prompt block | Maintainer (bundled) or user (runtime) | Agent Manager, at agent spawn/refresh |
| **Tool** | Built-in TS handler **or** MCP-sourced function | Built-in: Hive source tree. MCP-sourced: server | Running Agent |
| **MCP Server** | External process speaking MCP | Maintainer registers; the user installs the binary | Hive daemon (as MCP client) |

## Two-tier storage

Capabilities live in one of two tiers. The tier is determined by location; it is not declared in the manifest.

```
HIVE REPO (developer-controlled, committed to git)
hive-v2/
├── bundled/
│   ├── personal/
│   │   ├── skills/<name>/SKILL.md
│   │   ├── snippets/<name>/SNIPPET.md
│   │   └── mcp/<name>/MCP.yaml
│   ├── workplace/<workplace-id>/
│   │   ├── skills/<name>/SKILL.md
│   │   ├── snippets/<name>/SNIPPET.md
│   │   └── mcp/<name>/MCP.yaml
│   └── agents/
│       ├── root/HARNESS.md
│       └── agent-manager/HARNESS.md
└── src/capabilities/tools/<name>/tool.ts   # built-in Tools (TS, defineTool())

OS APP-STORAGE DIR (user-controlled, per-install, mutable at runtime)
<AppData>/Hive/
├── capabilities/
│   ├── skills/<name>/SKILL.md
│   ├── snippets/<name>/SNIPPET.md
│   └── mcp/<name>/MCP.yaml
└── agents/<agent-id>/
    ├── HARNESS.md            # fork of bundled Root/AM, or Worker authored by AM
    ├── memory/               # per-Agent Memory partition (always lives here)
    └── threads/               # per-Agent Threads (always live here)
```

**Bundled** capabilities ship with the Hive build; they are immutable at runtime and updatable only via git commit + rebuild. **Runtime** capabilities live in the OS app-storage directory and are mutable through the Settings UI or direct file drop.

Inside `bundled/`, **Personal** and **Workplace** are parallel namespaces — neither shadows the other. Workplace selection (which `workplace/<id>/` subtrees ship in a given build) is a build-time decision; on leaving an employer, the next build excludes that subtree. Same-name collision between `bundled/personal/skills/foo` and `bundled/workplace/<id>/skills/foo` is a load-time error: it indicates a packaging bug, not user intent.

## Name resolution: runtime shadows bundled

The Capability Registry resolves names through two precedence layers:

```
Layer 1 (top):   runtime   <AppData>/Hive/capabilities/<kind>/<name>/
Layer 2:         bundled   bundled/<personal|workplace/<id>>/<kind>/<name>/
```

Rules:

- **Runtime shadows bundled.** A runtime capability with the same name as a bundled one wins for resolution. The shadowed entry remains visible in the Settings UI with a "shadowed by runtime" marker.
- **Personal and Workplace at the bundled layer do not shadow each other.** They are parallel namespaces, not a hierarchy. Cross-origin collisions at the bundled layer are load-time errors.
- **Origin tag is preserved through resolution.** A runtime entry shadowing a workplace-origin bundled entry surfaces as runtime-origin (implicitly Personal in spirit — the user's local override).
- Every resolution that shadows is logged (trace channel) with `{name, kind, layer, origin, shadows}`. Not audited — see ADR-0004 "Audit vs trace": startup scan and hot-reload are system-driven, not user-driven, so they go to the trace log, not the audit table.

The same shadow pattern applies to Agent Harnesses: a runtime `<AppData>/Hive/agents/root/HARNESS.md` shadows the bundled `bundled/agents/root/HARNESS.md`. Memory and Threads always live in the runtime tier.

## No CLI install path

There is no `hive caps install` (or per-kind verb) for fetching Capabilities. Hive is not a package manager.

Two add paths exist:

- **Developer adds to bundled.** Edit the file in `bundled/<origin>/<kind>/<name>/` directly; commit; rebuild.
- **End user adds at runtime.** Use the Settings UI's "Add Skill / Snippet / MCP" action, or drop a folder into `<AppData>/Hive/capabilities/<kind>/<name>/`. The watcher picks it up.

Promotion from runtime to bundled is a manual developer action — typically: ask a coding agent in an IDE to read the file from app-storage and copy it into the Hive repo, then commit. The desktop app never writes into the Hive repo.

Hive does not run `pip install`, `npm install`, `cargo install`, or container fetches. Each ecosystem keeps its own package manager. The manifest's `compatibility.system` is the contract: Hive validates prereqs at the right moment (Run-start for built-in Tools, server-start for MCP servers); missing prereqs surface as actionable errors pointing to the capability's README. This is the same posture VS Code extensions take.

## Per-kind manifest schemas

Only `name` and `description` are universal. Everything else is per-kind. Each per-kind Zod schema uses `.strict()` — unknown fields are load-time errors.

```
Universal (every manifest):
  name, description

Derived at load (not authored):
  origin    (from path: personal | workplace)
  source    (filesystem | builtin | mcp-discovered)
  layer     (runtime | bundled)

Per-kind extensions:

  Skill:   { tags?, source?,                         + markdown body
             manualInvocationOnly?,
             allowedTools?,
             argumentHint? }
           source: { url, ref, fetchedAt }            for vendored external skills
                                                       (build-time refresh, never runtime)
           manualInvocationOnly: true                 description excluded from always-on
                                                       prompt; body loaded only when the
                                                       user invokes by name (slash command)
                                                       or load_skill(name) is called
           allowedTools: [string]                     tool-name globs the Permission System
                                                       reads when the skill body runs (v1.1)
           argumentHint: string                       UI hint for slash-command arg prompt

  Snippet: { tags? }                                 + markdown body

  Tool:    { title?, inputSchema, annotations?,
             maxResultSize?, compatibility?,
             providerHints? }                         (defineTool() in TS; no manifest file)
           annotations: { readOnlyHint?,
                          destructiveHint?,
                          idempotentHint?,
                          openWorldHint? }            MCP-style; feeds Permission System

  MCP:     { title?, transport, command|url, env?,
             compatibility.system? }                  + no body

  Harness: { agentId, backend, domain,
             bindings, config }                       + prompt body
           (NOT a Capability; see next section)
```

`compatibility` and `providerHints` are declared on primitive kinds (Tool, MCP Server) and derived for the composite kind (Harness) at Run-start by walking the bindings.

## Agent Harness is not a Capability

Agent Harness is removed from the Capability kinds list. Reasons:

- **Not reusable.** One Harness per Agent; not bound by other Agents.
- **Not indexed in the Capability Registry.** Indexed in the **Agent Catalog**.
- **Not authored as a portable artifact.** The bundled Root and Agent Manager Harnesses ship with Hive; all other Harnesses are runtime artifacts authored by the Agent Manager.
- **Capability manifest fields mostly don't apply.** `compatibility`, `providerHints`, `tags`, `annotations`, `maxResultSize` are all either inapplicable or derived.

The Harness is the **on-disk artifact** of an Agent. The Capability Registry and the Agent Catalog are two distinct indexes; they share lower-level storage primitives (manifest parsing, atomic writes, frontmatter Zod, hot-reload, audit emission) but are separate at the registry seam.

## Harness mutability: UI + Agent Manager, not frozen

ADR-0003's "Harness is a frozen artifact" wording is too strong now. The Harness is the canonical mutable record of an Agent's configuration:

- **Bindings** (which Skills / Tools / MCPs the Agent has) are editable through the Settings UI as a multi-select checkbox list. Changes write directly to the Harness file.
- **Prompt body** (the system prompt) is rewritten by Agent Manager Runs.
- **Backend config** is editable through the Settings UI using a form generated from the backend's Zod schema.

What is preserved from "frozen":

- Edits to upstream **Prompt Snippets** never propagate automatically. The Harness body is the resolved artifact, not a live include.
- Each **Run** snapshots the Harness at Run start. Edits made during a Run do not affect that Run. The next Run picks up the new state — including in existing Threads.

The Settings UI is the primary surface for binding edits; the Agent Manager remains the only surface for prompt-body rewrites.

## Discovery and hot-reload

Same posture as ADR-0006 for Config. At daemon start:

- **Eager full scan with fail-quarantine.** Each kind's module scans both bundled and runtime roots for that kind. Malformed manifests are logged + skipped + surfaced via `hive doctor`; the daemon starts successfully.
- **Hot-reload via filesystem watcher** on both layers (bundled paths exist at runtime in dev mode when the daemon runs from the source tree; in installed-app mode the bundled root is read-only and the watcher catches nothing there until the next upgrade).
- **Bound capability versions are snapshotted at Run start.** A Skill edited mid-Run does not retroactively change the running Run's view; the next Run picks up the new content.

## Capability Compatibility validation

Compatibility is declared on the manifest of the primitive kinds:

```yaml
compatibility:
  model:    [tool_use, reasoning_visible, context_min_200k]
  system:
    binaries:  [gog, npx]
    env:       [AZURE_TOKEN]
    services:  [docker]
    platforms: [win32, darwin, linux]
```

Validation timing:

- **Model-side**: validated at Run start against the chosen model. Missing capability → Run refuses to start with a clear error.
- **System-side**: validated at MCP server start (for MCP) or at Run start (for built-in Tools bound to the Harness). Missing prereq → server doesn't start / Tool not exposed / Run refuses with a pointer to the capability's README.

Hive validates prereqs. Hive does not install them.

## Built-in Tools: TS only, no on-disk manifest

Built-in Tools live in the Hive source tree (`src/capabilities/tools/<name>/tool.ts`), registered at daemon startup via `defineTool({...})`. The `defineTool` call is the manifest:

```typescript
defineTool({
  name: "run_shell",
  title: "Run Shell Command",
  description: "...",
  input: z.object({ command: z.string(), args: z.array(z.string()) }),
  annotations: { destructive: true, openWorld: true },
  maxResultSize: 100_000,
  compatibility: { system: { platforms: ["win32", "darwin", "linux"] } },
  handler: async (input, ctx) => { /* ... */ },
});
```

Built-in Tools have in-process access to Hive internals (Memory, Run spawning, the ModelGateway). User extension of Tools happens only via MCP — Hive does not dynamically import user TypeScript.

Per ADR-0003, restricted Tools are bound only to specific roles by the Harness binding, not by per-call runtime gates: `spawn_sub_agent` to Root only; `create_agent` / `update_agent_harness` / `destroy_agent` / `list_capabilities` / `get_capability_manifest` to the Agent Manager only. The two browsing tools (`list_capabilities`, `get_capability_manifest`) are how the AM achieves "full Registry visibility" — by *querying* the Registry on-demand when authoring a Harness, not by binding every Capability into its own context. Bindings inflate the agent's always-on prompt with one-line descriptions; browsing tools return descriptions as tool-call results when the AM asks. This keeps the AM's runtime context bounded regardless of how large the Registry grows.

## MCP servers: bundled is just a manifest

A bundled MCP entry is just an `MCP.yaml` declaring "Hive knows how to launch this MCP server":

```yaml
name: ado
title: Azure DevOps
description: Work items, pipelines, repos via ADO API.
transport: stdio
command: [npx, "@ado/mcp-server"]
env:
  AZURE_TOKEN: ${secret:azure_token}
compatibility:
  system:
    binaries: [npx]
    platforms: [win32, darwin, linux]
```

The user installs the underlying MCP server binary themselves (per its README — `npm install`, `uv tool install`, Docker pull, native binary). At server-start, `compatibility.system.binaries` validates the binary is on `$PATH`; if not, the server doesn't start and a clear error is shown.

This is what enables Hive to support hundreds of MCP servers with negligible footprint — the bundled `MCP.yaml` files are tiny, and the heavy lifting (the server binaries themselves) lives in the user's normal package-manager ecosystem.

## Event emissions

The Capability Registry and the Agent Catalog emit typed event streams. The Audit Log subscribes per ADR-0004's user/agent-action filter; the Trace Log captures everything else.

| Module | Event | Audit? | Trace? |
|---|---|---|---|
| Capability Registry | `capability.registered` (startup scan) | no | yes |
| Capability Registry | `capability.unregistered` (hot-reload remove) | no | yes |
| Capability Registry | `capability.changed` (hot-reload edit) | no | yes |
| Agent Catalog | `agent.created` (startup scan inventory) | no | yes |
| Agent Catalog | `agent.created` (Agent Manager Run creates a Worker) | **yes** | yes |
| Agent Catalog | `agent.destroyed` (Agent Manager Run destroys a Worker) | **yes** | yes |
| Agent Catalog | `harness.updated` (UI binding edit) | **yes** | yes |
| Agent Catalog | `harness.updated` (Agent Manager rewrite or reset) | **yes** | yes |

Audit captures *user-driven* and *agent-driven* state changes. Scan-time inventory and filesystem-watcher events go to the Trace Log only (Pino JSONL at `<runtime>/logs/daemon.log`). This keeps `audit.db` quiet at boot and the audit table queryable for "what did the user/AM do?" without scan-noise drowning the signal. See ADR-0004 "Audit vs trace" for the full split.

## Out-of-box experience

The first-launch desktop app is fully functional. Bundled defaults ensure:

- The bundled Root Agent and Agent Manager Harnesses arrive pre-equipped with sensible default bindings (memory, ask_user, save_artifact, plus role-restricted Tools).
- The bundled Snippet pack covers what the Agent Manager needs to author other Agents (voice, permission discipline, prompt-authoring guidance).
- The bundled Skill set is comprehensive — see "Inclusion principle" below.

The user reaches "I have a working personal AI" without any pre-flight configuration.

## Inclusion principle: all capabilities in the repo

All capabilities go in the bundled repo unconditionally. Enablement is per-Agent, not per-deployment — the **Agent Manager** picks which Capabilities to bind when authoring a Harness, and the user toggles bindings through the Settings UI. There is no harm in shipping a large pool: unbound Capabilities consume no runtime resources, and the Agent Manager evaluating more options is intended behavior, not a cost.

This rules out the "we'll keep the bundled set lean and let users add at runtime for everything else" posture. Runtime-tier capabilities are for **per-install customization** (one user's local tweak), not for working around a thin bundled set. The repo is the canonical library; selection happens at the binding seam.

Concretely: a maintainer aggressively vendors useful upstream capability libraries (e.g., gstack, hyperframes, superpowers, mattpocock/skills) into `bundled/personal/skills/` with `source:` blocks tracking each upstream pin. New capabilities get added to the repo, not held out.

## Cross-machine portability (deferred)

In v1, the runtime tier (`<AppData>/Hive/`) is single-install. Forks of Root/AM, Worker Agents, runtime-added Capabilities, Memory, and Threads do not travel across machines. The bundled tier travels via the user's Hive repo (clone, build, install).

A v1.1+ account-sync mechanism is contemplated but explicitly out of scope. The two-tier model is designed so that adding sync later is a pure additive change to the runtime tier's persistence layer — it does not affect bundled, the registry, the resolution rules, or any consumer of the Capability Registry.

## What this ADR amends in ADR-0003

- **Capability kinds**: five → four. Agent Harness removed.
- **Storage layout**: not `~/.hive/capabilities/...`. Two tiers: bundled (in repo) + runtime (in app-storage).
- **CLI surface**: no `hive caps install` or per-kind install verbs. The runtime CLI is for daemon admin and daemon-as-client one-shots; capability installation is not a CLI operation.
- **Harness mutability**: not "frozen at agent-creation time." Bindings editable live through the Settings UI; prompt body rewritten by Agent Manager Runs; Run-start snapshot semantics preserved.
- **Discovery & name resolution**: explicit shadow rule (runtime > bundled), explicit parallel-not-hierarchical for Personal/Workplace at bundled, explicit error mode for in-layer same-origin collisions.

## Verification

This ADR is correct if, after implementation:

1. A new bundled Skill added by editing `bundled/personal/skills/foo/SKILL.md` in the repo and committing appears in the Registry on next daemon start (or live, if running in dev mode against the source tree).
2. A new runtime Skill added by dropping a folder into `<AppData>/Hive/capabilities/skills/foo/` appears in the Registry within seconds, without any CLI command.
3. If both a `bundled/personal/skills/foo` and a `<AppData>/Hive/capabilities/skills/foo` exist, the runtime entry wins and the **trace log** records the shadow (scan-time event; not audit-table).
4. If both `bundled/personal/skills/foo` and `bundled/workplace/<id>/skills/foo` exist, the daemon refuses to start (or quarantines both with a clear error).
5. Toggling a Capability binding on/off in the Settings UI takes effect on the next Run in the affected Agent's existing Thread.
6. Deleting `<AppData>/Hive/agents/root/HARNESS.md` causes Root to resolve from `bundled/agents/root/HARNESS.md` on next Run, with Memory and Threads preserved.
7. An MCP server declared in `bundled/personal/mcp/ado/MCP.yaml` whose `compatibility.system.binaries: [npx]` is unmet does not start, and the error message points the user to the capability's README.
8. There is no `hive caps install` (or `hive skill install`, etc.) command in the CLI.
9. The Trace Log (`<runtime>/logs/daemon.log`) contains `capability.registered` records for every Capability discovered at startup, including layer and origin. The Audit Log (`<runtime>/audit.db`) contains `harness.updated` rows for every binding change made through the Settings UI — and nothing else from the Registry/Catalog scan path (per ADR-0004 "Audit vs trace").

If any of these is false, the design is wrong — fix here before further commitments.
