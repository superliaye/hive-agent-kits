# Capability Layer Design

## What this ADR records

The shape and lifecycle of every **Capability** kind in Hive v1: what they are, how they're stored on disk, who consumes them, when they run, and how the CLI participates. Closes ADR-0001 blocker #6 (Agent Harness "template" vs "instance" disambiguation). Leaves open ADR-0001 blockers #2 (secrets), #3 (name-collision), and the permission-system shape — those get their own ADRs.

## The five Capability kinds

Hive recognizes exactly five Capability kinds. Each carries an **origin** tag (Personal | Workplace).

| Kind | Content | Consumed by | When |
|---|---|---|---|
| **Skill** | Markdown technique file | The running Agent, mid-Run, when matched | Per-Run, on demand |
| **Prompt Snippet** | Markdown prompt block (voice, practice, convention) | The **Agent Manager** | At agent spawn / explicit prompt refresh |
| **Tool** | Built-in TS handler **or** MCP-sourced function | The running Agent | Per Tool call |
| **MCP Server** | External process speaking Model Context Protocol | Hive daemon (as MCP client) | While ref-counted by Harness bindings |
| **Agent Harness** | Frozen prompt + identity + bound Capabilities | Hive daemon (Run setup) | At Run start |

Prompt Snippet is new in this ADR. The other four were already named in CONTEXT.md; this ADR pins their internals.

## Agent Harness is a frozen artifact (resolves ADR-0001 #6)

There is no live Harness template. The Harness *is* the instance:

- A single file/folder per Agent. Frozen `system prompt` (markdown text written by the Agent Manager) + identity + the names of bound Skills, Tools, and MCP Servers.
- "Template-like" reuse is supplied by **Prompt Snippets**, not by live includes.
- Editing a Snippet does **not** propagate. The user (or another Agent) explicitly asks the Agent Manager to refresh an Agent's prompt; the Agent Manager re-authors the Harness with the latest Snippets as input.
- The Audit Log records every Harness write, with the Snippets consulted.

This trades automatic DRY for stability. The user is shielded from silent behavior drift; they get DRY back when they ask for it.

## Prompt Snippet is a separate kind, not a Skill flavor

Skills and Snippets both look like "markdown + manifest + origin tag" but differ in consumer and audience:

- Skill descriptions are written for *the running Agent* to match against the current user request.
- Snippet descriptions are written for *the Agent Manager* to evaluate fit while authoring a new Harness.

Conflating them under one Capability kind would produce mush in both manifests and the Capability Registry browser. They are separate kinds.

Snippets are advisory inputs to prompt authoring — the Agent Manager may adopt verbatim, paraphrase, combine, or omit. The result is one monolithic frozen prompt in the target Agent's Harness; Snippet content never enters that Agent's runtime context.

## On-disk shape: folder-per-capability for markdown-bearing kinds

Skills, Prompt Snippets, and Agent Harnesses each live in a folder containing a canonical manifest file plus optional sibling assets:

```
~/.hive/capabilities/
├── skills/
│   └── <name>/
│       ├── SKILL.md          # YAML frontmatter + body
│       └── (examples/, scripts/, assets/ — optional)
├── snippets/
│   └── <name>/
│       └── SNIPPET.md
└── harnesses/
    └── <agent-id>/
        └── HARNESS.md
```

Discoverable by directory scan; hot-reloadable via `Bun.fileWatcher`. Manifest *is* the markdown frontmatter — no separate manifest file.

Rejected: single-file `<name>.md`, or hybrid promote-when-needed. The first 10 Skills can live as single files; the next 50 will want siblings. Pay the directory cost upfront.

## Tools: built-in TypeScript or MCP-sourced — no user TypeScript

Tools come from exactly two places:

- **Built-in.** TypeScript handler in the Hive daemon source tree (`src/capabilities/tools/<name>/tool.ts`), exported via a typed `defineTool({...})` helper with Zod schema, `providerHints`, and `compatibility` fields. Has in-process access to Hive internals (Memory, Run spawning, the gateway). Kernel primitives live here: `memory_read`, `memory_write`, `ask_user`, `spawn_sub_agent`, `save_artifact`, `run_shell`, etc.
- **MCP-sourced.** Surfaced from a configured MCP Server. Origin inherits from the server.

User extension of Tools happens *exclusively* via MCP. Hive does not dynamically `import()` user TypeScript from a data directory; the process boundary that MCP provides is what gives user-installed Tools their trust model. A user who wants a new Tool writes (or installs) a tiny MCP server.

## Kernel `run_shell` Tool + MCP wrappers for CLIs that earn structure

Agents invoke external CLIs through two coexisting paths:

- **`run_shell`** — a built-in Tool that runs an arbitrary shell command. Gated by the Permission System with a per-Agent allowlist. Used for one-off, exploratory, or low-frequency invocations where structured output isn't needed.
- **MCP wrappers** — a Personal- or Workplace-origin MCP server wraps a CLI and exposes typed Tools. Used when the CLI is called often, output is structured, or the model picks the right Tool more reliably with a typed surface.

Rule of thumb: wrap a CLI in MCP when it's daily-use *and* output is structured *and* schema visibility improves selection accuracy. Otherwise, leave it on `run_shell`. There is no auto-detection of CLIs on `$PATH` — availability is declared via Capability Compatibility (`requires: [{binary: "gog"}]`) and validated at Run start (built-in) or server start (MCP).

## MCP server lifecycle: ref-counted by Harness bindings

An MCP server's process:

- **Starts** when the first Agent in the Catalog whose Harness binds it appears.
- **Stops** when the last such Agent unbinds or is destroyed.
- **Crashes** are caught by a watchdog with exponential-backoff reconnect (lifted from CLAW); the audit log records every restart.

This avoids cold-start latency for actively-bound servers (they're warm whenever an Agent that needs them exists) and avoids running servers no Agent has asked for. Reference counting is on Harness *bindings*, not on active Runs — Threads are persistent and Runs come and go on the same Agent.

## Transport: stdio + local HTTP only in v1

Both transports are supported on day one:

- **stdio.** The dominant case. Every MCP server you install in v1 is a stdio subprocess.
- **HTTP at `localhost:...`.** For shared local services and user-written servers running outside the daemon's process tree.

Rejected for v1: SSE, WebSocket, and any remote (non-`localhost`) MCP. These add auth, certificate, and credential-leak concerns that don't pay off until v1.1. Adding them later is a pure additive change to the transport field.

## CLI: three roles in v1

The `hive` binary plays three roles, all as a client to the daemon over `localhost:3117`:

- **Daemon admin** — `hive daemon start/stop/status/install/uninstall`, `hive logs`, `hive doctor`. The control plane.
- **Capability + Agent admin** — `hive agents …`, `hive caps …`, `hive memory …`, `hive sync …`. The scriptable mirror of the Web UI.
- **One-shot user surface** — `hive send "…"` streams a Run result to stdout. Bridges any terminal context (git hook, Makefile, another agent) into Hive.

Deferred: a full TUI (Ink-style interactive terminal client). Web UI is the primary v1 user surface; if a TUI is needed later, CLAW's TUI shape can be lifted then.

Auth: token from `~/.hive/.token` (chmod 0600), lifted from CLAW. CLI prompts to start the daemon if not running.

## Capability Compatibility extends to system prerequisites

Beyond model-side requirements (`tool_use`, reasoning visibility, context window), Capability Compatibility now also covers system-side prerequisites:

- Required binaries on `$PATH` (`gog`, `gh`, `docker`, …)
- Required services (Docker daemon, Ollama)
- Required env vars (`AZURE_TOKEN`, `OPENAI_API_KEY` for a specific provider)

Validated at Run start for built-in Tools and at server start for MCP servers. Missing prerequisites surface a clear actionable error — they do not silently degrade.

## Open grilling backlog

The following decisions are *not* settled and should be the next grill targets. Each entry is self-contained enough to resume cold on a different machine.

### G1 — MCP Tool namespacing under collisions (ADR-0001 blocker #3)

When `gog-mcp` exposes `search` and another MCP server also exposes `search`, what does the Agent's tool call resolve to? Same question across Personal vs Workplace origin: does a Workplace `web_fetch` shadow a Personal one, or vice versa?

Options to consider:
- **Fully qualified.** `<server>.<tool>` always; flat names never legal in Harness bindings. Most explicit, most verbose.
- **Flat with collision error.** The Registry refuses to load if two servers expose the same tool name unless an alias is set.
- **Flat with origin precedence.** Workplace overrides Personal (or vice versa); audit log records the shadow.
- **Hybrid.** Flat by default; qualified form available for tie-breaking.

Touches: ADR-0001 blocker #3, ADR-0002 manifest design, the Capability Registry browser UI.

### G2 — Secrets / MCP auth (ADR-0001 blocker #2)

MCP servers and built-in Tools both need credentials (`GH_TOKEN`, `OPENAI_API_KEY`, Azure SPN, etc.). Where do they live? How are they injected? ADR-0002 already flagged the choice: adopt `pi-ai`'s `auth-profiles` surface or wrap it under a Hive-native Secrets primitive.

Questions to resolve:
- Storage backend — OS keychain (Keychain / DPAPI / libsecret), encrypted file, or both?
- Naming — by capability (`gog.token`), by profile (`work` / `personal`), or by raw env var name?
- Origin tagging — does a secret carry Personal/Workplace origin the way Capabilities do? (Probably yes.)
- Per-Agent vs global — can two Agents see different secrets for the same name?
- Redaction — audit log + UI must never leak secrets; the redaction policy needs to be a first-class concept, not a grep.

Touches: ADR-0001 blocker #2, ADR-0002 deferred decision on `auth-profiles`, every MCP server's env, the audit log.

### G3 — Skill matching mechanism at Run time

CONTEXT.md says Skills are "loaded only when matched; not always-on context." Matched **how**?

Options:
- **Model-picks-by-description.** Skill descriptions are visible to the model as a tool-list; model invokes a `load_skill(name)` Tool. Claude-Code-style.
- **Hand-bound list on the Harness.** The Harness names exactly which Skills are available; description-style matching is internal to those.
- **Both.** Harness narrows the universe; model picks within.
- **Heuristic match.** The Run executor runs a small classifier over the user message and pre-loads top-K Skill descriptions; model can then invoke their full body.

Touches: Skill manifest description format, the Run executor's prompt assembly, the model's tool-list construction, context-budget allocator (work-claw inventory line ~85).

### G4 — Snippet metadata categories

Should Snippet manifests require a category enum (`voice`, `practice`, `convention`, `process`, `domain-rule`, …) or just carry free-form tags? Affects how the Agent Manager discovers them ("show me all `voice` Snippets when authoring a new coding agent") and how the Registry browser groups them.

Sub-questions:
- Are categories closed (fixed enum, evolves slowly) or open (free-form, user-defined)?
- Can a Snippet be in multiple categories?
- Does category interact with origin? (E.g., `domain-rule` Snippets are almost always Workplace-origin.)

Touches: Snippet manifest schema, Agent Manager discovery query, Registry browser UI.

### G5 — Agent Manager workflow

This is the largest open thread. The Agent Manager is on the critical path for every agent creation and every prompt refresh. Open questions:

- **Invocation.** Is the Agent Manager always a sub-Agent the Root Agent dispatches to ("Make a coding agent for odsp-web" → Root → Manager), or can the user address it directly?
- **Input.** Natural language description from the user only? Plus optional explicit references ("use these Snippets")? Plus a starting Harness to fork?
- **Inner loop.** Does the Agent Manager (a) ask the user clarifying questions before authoring, (b) draft the Harness then ask for review, or (c) author autonomously and let the user iterate via "refresh" Runs?
- **Output.** Writes the Harness file directly, or proposes a diff for user approval first?
- **Refresh.** What does "Agent Manager, please refresh agent X" actually look like? Re-author from scratch with current Snippets? Delta against the existing prompt? Preserve user hand-edits?
- **Self-spawn.** Can the Agent Manager create another Agent Manager (e.g., a domain-specialized variant for prompt engineering inside a particular vertical)?
- **Discovery.** How does the Agent Manager know what Snippets exist? Reads the Registry directly? Through a `list_capabilities` Tool? Pre-loaded into its system prompt?

Touches: every Capability kind, the Permission System (Agent Manager has elevated authority — explicit boundary needed, ADR-0001's deferred decision on "Agent Manager authority boundary").

### G6 — Permission System shape

`run_shell` is unshippable without this. CLAW had a 5-level autonomy dial + 14 action categories + classifier + custom rules + approval modal + trust pattern learning. The inventory marks most of this Core. Questions:

- Lift the 5-level dial wholesale (Strict / Supervised / Balanced / Autonomous / YOLO), or simplify for v1?
- Action categories — keep CLAW's 14, prune to a smaller set, or generalize? Need at minimum: `file_read`, `file_write`, `shell` (for `run_shell`), `network`, `memory_write`, `agent_spawn`, `mcp_tool`, `destructive`.
- Scope of a rule — per-Agent, per-Thread, per-Run, global? CLAW had per-channel; we already decided against per-Thread scoping in Q2 (Agent Harness binds, not Thread).
- Approval modal — one-time / always-allow / session-trust / deny — lift wholesale?
- Trust pattern learning (auto-suggest after N approvals) — v1 or v1.1?
- Pre-tool guardrails (`rm -rf`, `drop database`, etc.) — hard-coded denylist independent of autonomy dial?

Touches: kernel `run_shell` Tool (depends on this), Agent Manager (it elevates permissions), MCP Tool invocation, audit log enrichment.

---

These six are independent enough to grill in parallel sessions; G5 (Agent Manager) is the highest-leverage because every other decision flows through it.

## Verification

This ADR is correct if, after implementation, the following hold:

1. A new Capability of each kind can be added by dropping a folder (Skill/Snippet/Harness) or registering an MCP server in config — no daemon rebuild required for the markdown kinds.
2. Editing a Snippet does not change any existing Agent's prompt until an explicit Agent Manager refresh Run is invoked.
3. An MCP server is not running when no Agent in the Catalog binds it; it is running whenever at least one Agent does.
4. `hive send "…"` from a terminal produces a streamed Run against the configured Root Agent.
5. An agent denied permission to call `gog` via `run_shell` receives a clear refusal, audit-logged, with no shell execution attempted.

If any of these is false, the design is wrong — fix here before further commitments.
