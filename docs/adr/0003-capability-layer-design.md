# Capability Layer Design

## What this ADR records

The shape and lifecycle of every **Capability** kind in Hive v1: what they are, how they're stored on disk, who consumes them, when they run, and how the CLI participates. Closes ADR-0001 blocker #6 (Agent Harness "template" vs "instance" disambiguation). Leaves open ADR-0001 blocker #2 (secrets) and the permission-system shape — those get their own ADRs. Blocker #3 (name-collision) is downgraded out of the active backlog: with `run_shell` as the default CLI path, MCP servers in v1 are sparse and naturally divergent, so collisions are unlikely until v1.1.

## The five Capability kinds

Hive recognizes exactly five Capability kinds. Each carries an **origin** tag (Personal | Workplace).

| Kind | Content | Consumed by | When |
|---|---|---|---|
| **Skill** | Markdown technique file | The running Agent, mid-Run, when the model invokes `load_skill(name)` | Per-Run, progressive disclosure (descriptions always visible, body loaded on demand) |
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

**Snippet manifest is minimal: `{ name, description, origin }` + body.** No closed category enum, no hardcoded tag taxonomy. The `description` is free-form prose written for the Agent Manager (an LLM), which is perfectly capable of recognizing snippet purpose from natural language without a `category: "voice"` field. Adding a closed enum was considered and rejected: it would require maintenance, would constrain authoring, and would add no signal the description doesn't already carry.

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

- **Built-in.** TypeScript handler in the Hive daemon source tree (`src/capabilities/tools/<name>/tool.ts`), exported via a typed `defineTool({...})` helper with Zod schema, `providerHints`, and `compatibility` fields. Has in-process access to Hive internals (Memory, Run spawning, the gateway). Kernel Tools include both *universal* primitives that any Agent may bind (`memory_read`, `memory_write`, `ask_user`, `save_artifact`, `run_shell`, …) and *restricted* primitives bound only to specific roles: `spawn_sub_agent` / dispatch Tools are bound exclusively to the **Root Agent**; `create_agent` / `update_agent_harness` / `destroy_agent` / agent-lifecycle Tools are bound exclusively to the **Agent Manager**. Restriction is enforced by which Harness binds them, not by per-call checks at runtime.
- **MCP-sourced.** Surfaced from a configured MCP Server. Origin inherits from the server.

User extension of Tools happens *exclusively* via MCP. Hive does not dynamically `import()` user TypeScript from a data directory; the process boundary that MCP provides is what gives user-installed Tools their trust model. A user who wants a new Tool writes (or installs) a tiny MCP server.

## Agents invoke external CLIs through `run_shell` — period

There is one path for CLI invocation in v1:

- **`run_shell`** — a built-in Tool that runs an arbitrary shell command. Gated by the Permission System with a per-Agent per-command allowlist. The agent's call looks like `run_shell({command: "gog", args: ["search", "xyz"]})`. The daemon executes the command and returns `{stdout, stderr, exitCode}`.

**No MCP wrapping for single CLIs.** Wrapping `gog` (or any one CLI) in an MCP server is overkill — 30+ LOC of server code, subprocess lifecycle, JSON-RPC roundtrips, all to gain "typed Tool surface" for one verb. `run_shell` plus a sensible permission allowlist gives the same practical capability at zero authoring cost.

**No manifest-only shell Tools either.** A user-droppable YAML that declares "register a Tool named `gog_search` that runs `gog search`" was considered and rejected. It is strictly less capable than MCP and only marginally cheaper than `run_shell` once a permission allowlist exists; not worth the second mechanism in v1.

When a CLI invocation genuinely earns a typed Tool surface (high-frequency, structured output, state needed across calls, model selection accuracy materially improves), the path is **kernel-Tool promotion**: add a built-in TS Tool in the daemon source tree. That decision is made deliberately, in code, with review — not by users dropping manifests.

Availability is declared via Capability Compatibility (`requires: [{binary: "gog"}]`) on the Agent Harness, validated at Run start.

MCP servers remain in the architecture, but their role is narrowed: **server-class integrations** (ADO, GitHub Enterprise, Slack, internal company services, Ollama bridges, etc.) — surfaces that bring meaningful state, structured resources, or many related Tools at once. Not "I want to call one CLI."

## MCP server lifecycle: ref-counted by Harness bindings

An MCP server's process:

- **Starts** when the first Agent in the Catalog whose Harness binds it appears.
- **Stops** when the last such Agent unbinds or is destroyed.
- **Crashes** are caught by a watchdog with exponential-backoff reconnect; the audit log records every restart. (See OpenClaw's MCP integration for a working precedent of this pattern.)

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

Deferred: a full TUI (Ink-style interactive terminal client). Web UI is the primary v1 user surface; if a TUI is needed later, OpenClaw and Hermes both ship working TUIs to reference.

Auth: token from `~/.hive/.token` (chmod 0600). CLI prompts to start the daemon if not running.

## Harness config is backend-specific and schema-driven

The Agent Harness has a `backend` discriminator and a `config` object whose shape depends on the chosen backend:

```
backend: "native"
config:  { model, modelFallback?, thinkingEffort?, temperature?, maxTokens?, … }
         + bound Skills / Tools / MCP Servers + system prompt

backend: "claude-code"
config:  { model, thinkingBudget?, permissionMode?, workingDir?, allowedTools? }
         (claude-code brings its own tools/skills; no Hive Capability bindings)

backend: "codex"
config:  { model, reasoningEffort?, sandboxMode?, workingDir? }
```

Each backend ships a Zod schema for its `config`. The schema is the source of truth — the GUI fetches it from the daemon (a kernel verb like `getBackendConfigSchema(backend)`) and renders a dynamic form. Daemon validates writes. Adding a new backend is purely additive: ship the schema with the adapter.

**Model catalog** comes from the backend:
- `native`: pi-ai's `listModels()` (70+ providers exposed).
- `claude-code` / `codex`: queried from the CLI (`--list-models`) or read from a known static config; cached by the daemon, refreshable on demand.

**Per-Run model override.** A user may pick a different model in the UI for one specific Run ("just for this turn, use Sonnet not Opus"). Override is transient — never written back to the Harness. Resolution order at Run start: per-Run override → `config.model` → `config.modelFallback` → global deployment default. No per-Thread sticky model in v1.

This is the resolution to ADR-0002's "Per-Agent vs per-Run model selection policy" deferred decision.

## Authority partition: Root dispatches, Manager manages, Workers work

The kernel ships exactly two non-Worker Agents. Authority is partitioned at the Harness-binding level — no per-call runtime gate:

| Role | Dispatch (`spawn_sub_agent`) | Agent lifecycle (`create_agent`, …) | Backend |
|---|---|---|---|
| Root Agent | ✅ Bound | ❌ Not bound | always `native` |
| Agent Manager | ❌ Not bound | ✅ Bound | always `native` |
| Worker Agents (all others) | ❌ Not bound | ❌ Not bound | `native` or any CLI backend |

Any user may address any Agent directly. Convention is to talk to the Root Agent, which orchestrates multi-Agent workflows when needed. The Agent Manager is reachable directly when authoring or updating agents.

Knock-on rules:

- **Agent Manager is singleton.** Exactly one per deployment; cannot self-spawn another Agent Manager.
- **Agent Manager has full Registry visibility through dedicated browsing tools, not through bindings.** The AM *assembles* Capabilities into other Agents' Harnesses; it does not *invoke* them itself. Bindings and Registry visibility are distinct mechanisms: bindings surface a Capability's description in the agent's own system prompt (always-on, for self-invocation); Registry visibility is provided by built-in tools (`list_capabilities`, `get_capability_manifest`) the AM calls on-demand while authoring. The AM's Harness binds only what the AM itself uses at runtime (planning skills, lifecycle tools, browsing tools) — not every Capability in the Registry. The browsing tools are AM-restricted, in the same family as `create_agent` / `update_agent_harness` / `destroy_agent`.
- **Workers are leaves.** They do work — they don't fork.
- **Multi-Agent review flows are Root-orchestrated.** If a workflow wants "Agent Manager drafts a new Agent, then a Review Agent QAs it before commit," the Root Agent runs that pipeline. The Agent Manager does not dispatch the reviewer itself. (This pipeline is v1.1; v1 ships Agent Manager → direct write.)
- **Backend is orthogonal to role.** Worker Agents may use `native`, `claude-code`, `codex`, or any future CLI backend. Root and Agent Manager are always `native` because they need direct access to Hive internals (Registry, Harness writing, dispatch).

## Agent Manager workflow (resolved)

The Agent Manager's loop is intentionally underspecified — the details belong to its system prompt (designed when we write the Agent Manager Harness). What this ADR pins:

- **Invocation.** Direct user message, or dispatched-to by the Root Agent. Both supported. No requirement that AM be reached through Root.
- **Input.** Natural language ("Make a coding agent for odsp-web"). Optional structured references (specific Snippets / Skills / MCPs to consider) may be passed but aren't required.
- **Output.** Writes the target Agent's Harness file directly. The "review by sub-agent" pattern is deferred to v1.1 and requires the Root Agent to orchestrate (since AM can't dispatch).
- **Update is the same flow.** There is no separate "refresh" Tool. Authoring a new Harness and editing an existing one go through the same Agent Manager Run; the difference is whether a target Agent ID is supplied.
- **Discovery.** Agent Manager calls AM-restricted built-in browsing tools (`list_capabilities`, `get_capability_manifest`) to browse Snippets/Skills/Tools/MCPs in the Registry. The AM does *not* bind every Capability — bindings are for runtime self-invocation; Registry browsing is a separate mechanism, surfaced through tools whose results return Capability descriptions on-demand.
- **Inner-loop specifics** (clarification questions vs. autonomous draft, diff-vs-rewrite, preservation of hand-edits) are deferred to the Agent Manager's prompt design — they're prompt engineering, not architecture.

What's still open at this layer is the *approval boundary* — ADR-0001's deferred "Agent Manager authority: autonomous vs user-approved." The strong v1 default should be **user approval before any Harness write commits to disk**: AM proposes the file, the UI shows the diff, the user approves. Closing this open thread fully is a permission-system concern (see G2 — Permission System shape).

## Capability Compatibility extends to system prerequisites

Beyond model-side requirements (`tool_use`, reasoning visibility, context window), Capability Compatibility now also covers system-side prerequisites:

- Required binaries on `$PATH` (`gog`, `gh`, `docker`, …)
- Required services (Docker daemon, Ollama)
- Required env vars (`AZURE_TOKEN`, `OPENAI_API_KEY` for a specific provider)

Validated at Run start for built-in Tools and at server start for MCP servers. Missing prerequisites surface a clear actionable error — they do not silently degrade.

## Open grilling backlog

The following decisions are *not* settled and should be the next grill targets. Each entry is self-contained enough to resume cold on a different machine.

### G1 — Secrets / MCP auth (ADR-0001 blocker #2)

MCP servers, built-in Tools, and the ModelGateway (via pi-ai) all need credentials — provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …), OAuth credential triples (`{refresh, access, expires}` for Claude Pro / ChatGPT Plus / Copilot), and tool-specific tokens (`GH_TOKEN`, Azure SPN, etc.). Where do they live? How are they injected?

**Constraint from upstream.** pi-ai is stateless on disk for credentials (verified against the published source): it reads env vars at call time, accepts explicit `apiKey` overrides, and exposes `getOAuthApiKey(providerId, credentials) → { newCredentials, apiKey }` where the caller persists. There is no "auth-profiles" surface in pi-ai to adopt (an earlier ADR-0002 draft was incorrect on this). **Hive must build its own Secrets primitive regardless** — pi-ai is a consumer, not a provider.

**Concrete reference design — OpenClaw.** OpenClaw has solved most of this problem already. Key shapes worth borrowing (read from `E:\dev\GitRepos\openclaw\src\agents\auth-profiles\types.ts` and `docs/auth-credential-semantics.md`):

- Three credential types: `ApiKeyCredential`, `TokenCredential` (static bearer, not refreshed), `OAuthCredential` (with refresh handling).
- `SecretRef = { source: "env" | "file" | "exec", provider, id }` — values stored inline OR via reference. The `exec` source makes the backend pluggable for keychain, 1Password, Vault, gh-auth, etc.
- Per-agent profile store at `<workspace>/agents/<agent-id>/agent/auth-profiles.json`. Read-through inheritance: agent → `main` agent fallback. No copying of secret material.
- Two-file split: secrets store (`{version, profiles}`) vs. state store (`{version, order, lastGood, usageStats}`). State changes constantly; secrets rarely. Separated to avoid touching the credentials file.
- `copyToAgents` boolean per credential (api_key/token default portable; oauth default non-portable).
- Stable probe reason codes for diagnostics: `ok | excluded_by_auth_order | missing_credential | invalid_expires | expired | unresolved_ref | no_model`.
- External CLI credential discovery with scoped modes (`none` / `existing` / `scoped`) and `allowKeychainPrompt: false` for read-only paths.

**Constraint from upstream pi-ai.** pi-ai is stateless on disk for credentials (verified against the published source): it reads env vars at call time, accepts explicit `apiKey` overrides, and exposes `getOAuthApiKey(providerId, credentials) → { newCredentials, apiKey }` where the caller persists. No "auth-profiles" surface to adopt (an earlier ADR-0002 draft was incorrect). Hive's Secrets primitive sits *above* pi-ai and feeds it.

Questions remaining for Hive (narrowed):
- **Storage backend.** Adopt OpenClaw's plain-JSON-with-filesystem-perms baseline, or escalate to OS keychain (Keychain / DPAPI / libsecret) as the default `exec` source? Likely answer: plain JSON for v1 with `exec` source pluggable; ship a `hive secret get <id>` subcommand the `exec` source can call to bridge to OS keychain when users want.
- **Origin tagging.** Add explicit `origin: "personal" | "workplace"` alongside the OpenClaw `copyToAgents` boolean (more semantic than a single portability flag, aligns with Capability origin).
- **Multi-account.** Adopt OpenClaw's profile + usage-stats data shape, but defer the rotation/cooldown engine to v1.1 (premature for single-user single-account v1).
- **OAuth refresh persistence.** When pi-ai returns `newCredentials`, the Secrets primitive writes back to the per-Agent profile store. Atomicity / file-locking shape TBD — OpenClaw has working code in `src/agents/auth-profiles/oauth-file-lock-passthrough.test-support.ts` to reference.
- **Redaction policy.** First-class, not a grep. Where does the redaction layer live — at the audit log boundary, at the HTTP boundary, at the gateway? OpenClaw redacts at multiple points; pick one for Hive.

Touches: ADR-0001 blocker #2, ADR-0002 (Secrets deferred decision — corrected this session), every MCP server's env, the ModelGateway, the audit log, the portability mission.

**Hermes is also a reference but smaller in scope here.** Hermes has its own credential pool (`agent/credential_pool.py`, `agent/credential_sources.py`) — worth a glance for an alternative shape, but OpenClaw's design covers more of what Hive needs.

### G2 — Permission System shape

`run_shell` is unshippable without this. The work-claw internal-Microsoft inventory (a *feature wishlist*, not an architectural source) lists a 5-level autonomy dial, 14 action categories, classifier, custom rules, approval modal, and trust pattern learning. Treat those as starting hypotheses to evaluate against scenarios — not as a design to copy. Concrete questions for Hive:

- **Autonomy axis** — one global dial, per-Agent dial, or per-action-category? A coarse 5-level dial is simple but blunt; per-category gradations are more honest. v1 likely needs only two axes: per-Agent autonomy level + hard-coded denylist for destructive shell commands.
- **Action categories** — minimum viable set for v1: `shell` (for `run_shell` with per-command allowlist), `memory_write`, `agent_spawn`, `mcp_tool`, `destructive`. Add `file_read`/`file_write`/`network` only when actual Tools land that need them — categories without consumers are noise.
- **Scope of a rule** — per-Agent (lives on Harness) and global (deployment default). Q2 of this session ruled out per-Thread scope (Harness binds, not Thread). Per-Run is unnecessary.
- **Approval modal** — one-time / always-allow / session-trust / deny. Standard shape. Live in the Web UI; CLI gets a TTY prompt fallback.
- **Trust pattern learning** — defer to v1.1. Premature without usage data.
- **Pre-tool guardrails** — hard-coded denylist (`rm -rf /`, `DROP DATABASE`, `shutdown`, `format`, etc.) independent of autonomy dial. These are never allowed; the autonomy dial doesn't override them.
- **Reference reads.** Look at OpenClaw's permission/security layer (`src/security/`) and Hermes' `agent/file_safety.py` for working precedent on how other projects shaped this.

Touches: kernel `run_shell` Tool (depends on this), Agent Manager (it elevates permissions), MCP Tool invocation, audit log enrichment.

---

These two are independent. G2 (Permission System) is more urgent because `run_shell` and the Agent Manager's approval boundary both block on it.

## Verification

This ADR is correct if, after implementation, the following hold:

1. A new Capability of each kind can be added by dropping a folder (Skill/Snippet/Harness) or registering an MCP server in config — no daemon rebuild required for the markdown kinds.
2. Editing a Snippet does not change any existing Agent's prompt until an explicit Agent Manager refresh Run is invoked.
3. An MCP server is not running when no Agent in the Catalog binds it; it is running whenever at least one Agent does.
4. `hive send "…"` from a terminal produces a streamed Run against the configured Root Agent.
5. An agent denied permission to call `gog` via `run_shell` receives a clear refusal, audit-logged, with no shell execution attempted.

If any of these is false, the design is wrong — fix here before further commitments.
