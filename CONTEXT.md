# Hive — Agent Architecture

A portable personal AI system. **Capabilities** (skills, tools, MCP, Agent Harness templates) carry an **origin** tag (Personal — travels with the user; Workplace — lives at the company). Per-agent runtime data (memories, INDEX, Threads) accumulates separately at the deployment. Goal: 100x productivity carried with the user across companies and repos, without losing focus per domain.

## Language

**Agent**:
An identity with an **Agent Harness** + a **Memory** partition keyed by that identity. Mutable — can be renamed, repurposed, cloned, destroyed. Each agent has a **Domain** (logical focus area). Our **Agent** is the persistent thing (not the running thing). The running thing is a **Run**.
_Avoid_: "AI assistant", "bot" (too generic).

**Agent Harness**:
An Agent's on-disk artifact — the file that defines a specific Agent. *Not* a **Capability** (one per Agent, not reusable, lives in the **Agent Catalog** not the **Capability Registry**); it *binds* Capabilities by name. Written initially by the **Agent Manager**; thereafter editable through the Settings UI (toggling bindings) or further Agent Manager Runs (rewriting the prompt). Edits to upstream **Prompt Snippets** never propagate automatically — the Harness's content is fixed until an explicit edit. Each **Run** snapshots the Harness at Run start, so binding changes take effect on the *next* Run (including in existing Threads). Always contains: identity, a chosen **Agent Backend**, and backend-specific `config` (validated against a Zod schema the backend ships). For `native`-backend Agents, `config` carries the agent's **own** complete system prompt (drawing on **Prompt Snippets**) + bound **Skills** + bound **Tools** + bound **MCP Servers** + model preference (with fallback) + thinking effort + temperature. For CLI-driven backends (`claude-code`, `codex`, …), `config` is much smaller — model id, reasoning/thinking budget, permission mode, working directory, env — because the CLI brings its own tools and prompt machinery. The GUI renders an edit form by fetching the backend's schema, so adding a new backend is additive: ship its schema with its adapter. Updating the Harness requires an explicit Agent Manager Run. Users may pick the model, the **thinking effort**, and (for **Worker Agents**) the **Agent Backend** from the UI while chatting. By default a pick applies to **that conversation only** — it runs the current message and sticks for the Thread's later Runs, without touching the Agent's default. An explicit **apply-to-default** action promotes the conversation's choice to the Agent's default. Both the per-conversation choice and the default are stored at the deployment, *not* written back to the Harness, so a later Harness update never clobbers them. The **Agent Manager** sets each Agent's initial default at creation; a default may be **symbolic** ("latest model", "highest effort") and resolve at Run start rather than pinning a specific id. The axes are independent: setting one leaves the others untouched. The effort levels offered are model-specific — only the levels the chosen model actually supports (see [ADR-0013](docs/adr/0013-per-agent-model-default-resolution-tier.md)).
_Avoid_: "Harness" alone (we always prefix with "Agent"), "Persona" (implies only prompt).

**Memory**:
Per-**Agent** persisted data the agent reads and writes. Keyed by Agent identity, not by Domain. Format intentionally deferred — see Deferred Decisions.

**Domain**:
The logical focus area an **Agent** specializes in. Abstract — not a hardcoded partition. An agent whose Domain is "odsp-web coding" may still access augloop or other repos as secondary references; Domain describes _what the agent cares about_, not _what it can reach_. Access is determined by the **Agent Harness**'s bound Capabilities, not by Domain.

**Working Directory**:
The filesystem location a **Run** operates from — the `cwd` a CLI-driven **Agent Backend** is spawned in (and the default `cwd` for a `native` backend's `run_shell`). Resolved per Run: a per-conversation choice, else the Agent's default, else a per-Agent workspace under `~/.hive`. Carries two patterns: an **agent bound to a repo** (set the Agent default to the repo root — a CLI started there inherits that repo's *own* committed Skills/MCP/conventions automatically, composing with the Agent's projected portable Skills) and an **agent you aim per conversation** (no Agent default; each Thread points at a repo, or a parent dir for cross-repo work). Distinct from **Domain**: Domain is the abstract focus label; Working Directory is the concrete operating location.

**Thread**:
A persistent conversation between a user (or another agent) and an **Agent** — what the UI surfaces to users as a _conversation_. Holds message history. One Agent can have multiple Threads, in parallel or sequentially. Modeled after OpenAI's Thread.

**Thread Title**:
A short human-readable label for a **Thread**. Its **Title Source** records whether it was set automatically (derived from the conversation) or chosen by the user; a user-chosen title is sticky and an automatic one never overrides it. The automatic title is generated by the system, best-effort, once the conversation has had at least one completed exchange, and only while the Thread is still untitled and auto-sourced. Generation is resilient to interruption: if an early exchange was cut short, it retries on a later completed exchange, and stops permanently once any title exists.

**Conversation Lifecycle**:
A **Thread** is always in one of three lifecycle states: _active_ (in the working list), _archived_ (set aside but fully readable), or _deleted_ (gone). There is no context-reset: Hive never trims, summarizes-down, or resets a conversation, and a Run always receives the full conversation history. A conversation is only ever archived or deleted — never truncated.

**Archived**:
A lifecycle state of a **Thread**: set aside, out of the active list, but not deleted and still fully readable. Archiving is reversible-by-design and may be done by the user or automatically (**Auto-Archive**).

**Auto-Archive**:
The system archiving a **Thread** that has gone untouched for long enough — roughly two months with no new message. System-initiated, not a user action — it is a housekeeping behavior, not an audited decision.

**Last-Read / Unread**:
Last-Read marks how far the user has caught up on a **Thread**. A Thread is Unread when its newest terminal **Run** completed successfully and the user has not yet seen it — the per-conversation unseen-finished condition, distinct from a _failed_ terminal Run. Both Unread and the failed state clear when the user reads the conversation.

**Thread Status**:
The derived state of a **Thread** for display, in precedence order _running > failed > unread > idle_: _running_ (a **Run** is in flight), _failed_ (the thread's newest terminal Run failed or was cancelled and the user hasn't read it; clears on read), _unread_ (the newest terminal Run completed and the user hasn't seen it), or _idle_ (nothing pending). Derived, not stored — a function of in-flight Runs, the newest terminal Run, and Last-Read.

**Run**:
One execution of an **Agent** on a **Thread**. Spans from invocation to completion — may include multiple model turns and tool calls. Multiple Runs of the same Agent (on the same or different Threads) may execute concurrently. The internal mechanics of a Run depend on the Agent's **Agent Backend**: a `native`-backend Run executes Hive's model-plus-tool-use loop in-process; a CLI-backend Run spawns an external agent CLI (`claude-code`, `codex`, …) and streams its output. From the outside (UI, CLI, audit), every Run is a stream of `RunEvent`s — the backend is invisible at the seam. Modeled after OpenAI's Run.

**Agent Catalog**:
The directory of agents at a deployment. One entry per **Agent**: name, **Agent Harness**, **Domain** (label), current state. Used for routing, discovery, and lifecycle management. A consumer reads it to answer "what agents exist and which one should I send this to?"

**Root Agent**:
The user's entry-point **Agent**. Handles simple requests directly and **is the only Agent allowed to dispatch tasks to other Agents** (the `spawn_sub_agent` / dispatch Tools are bound exclusively to its Harness). Any user can address any Agent directly, but Root is the conventional entry point and the orchestrator for multi-Agent workflows.

**Agent Manager**:
A specialized **Agent** that creates, configures, and destroys other Agents. **The only Agent allowed to manage Agents** — agent-lifecycle Tools (`create_agent`, `update_agent_harness`, `destroy_agent`, etc.) are bound exclusively to its Harness. Cannot dispatch tasks to other Agents (that's Root's privilege); cannot self-spawn (exactly one Agent Manager per deployment). Has full **Registry visibility** through AM-restricted browsing tools (`list_capabilities`, `get_capability_manifest`) — *not* through bindings. The AM assembles Capabilities into other Agents' Harnesses by browsing the Registry on-demand; its own bindings cover only what the AM itself invokes at runtime (planning skills, lifecycle tools, browsing tools). Bindings and Registry visibility are distinct mechanisms — see [ADR-0003](docs/adr/0003-capability-layer-design.md). Separated from the **Root Agent** for focus reasons — agent design is heavy context.

**Worker Agent**:
Any **Agent** that is not the **Root Agent** or the **Agent Manager**. Workers do work: read/write Memory, call Tools, invoke MCP Servers, load Skills. They **cannot dispatch** (no `spawn_sub_agent`) and **cannot manage** other Agents (no agent-lifecycle Tools). This is the default Agent class; the kernel ships only two non-Worker Agents (Root and Manager).

**Skill**:
An on-demand technique file an Agent has access to. A **Capability** with Personal-origin (typically). Two stages:
- **Spawn-time binding.** The **Agent Manager** picks which Skills an Agent has when authoring the Harness. The chosen names are frozen into the Harness alongside Tools and MCP Servers. Set is fixed until an explicit Agent Manager refresh.
- **Run-time progressive disclosure.** At Run start, *all bound* Skill descriptions are surfaced to the model (one line each, cheap). The model decides when to invoke `load_skill(name)` based on the current request; only then is the full body fetched into context. The model is the matcher — same pattern as Tools.

Manifest fields: `name`, `description` (one-line trigger the model reads to decide invocation), `origin`. Body is the technique itself.

**Prompt Snippet**:
A reusable block of prompt text — voice rules, coding practices, review standards, domain conventions, etc. A **Capability** with an origin tag. **Not** loaded into any running agent's context. Consumed only by the **Agent Manager** at agent-creation (or prompt-refresh) time as reference material when authoring another agent's Harness prompt. The Agent Manager may adopt verbatim, paraphrase, combine, or omit. Snippets are advisory inputs to prompt authoring; they are never live includes. Manifest fields: `name`, `description` (free-form prose — the Agent Manager reads this to decide fit), `origin`. No closed category enum: the Agent Manager is an LLM and recognizes the snippet's purpose from the description.
_Avoid_: "Persona", "Role", "Soul", "Instructions" — those are content categories, not the kind. The kind is "Prompt Snippet".

**Tool**:
A function an agent can call. A **Capability**. Either **built-in** (TypeScript handler in the Hive daemon source tree — Personal-origin, ships with Hive itself, has direct in-process access to Hive internals like Memory and Run spawning) or **MCP-sourced** (surfaced from a configured **MCP Server**; origin inherits from the server). Hive does not load arbitrary user TypeScript at runtime; new Tool *kinds* arrive via MCP servers or by adding a built-in Tool to the daemon source. For invoking external CLIs (`gog`, `gh`, `docker`, `az`), the built-in `run_shell` Tool plus a per-Agent command allowlist is the standard path — wrapping single CLIs in dedicated Tools or MCP servers is not the recommended pattern.

**MCP Server**:
An external process providing tools and resources via the Model Context Protocol. A **Capability**. Origin is per-server: a personal MCP server (a local Ollama bridge, a personal note-taking server) is Personal-origin and travels with you; a company MCP server (ADO, internal allowlists, internal data services) is Workplace-origin and stays. **MCP's role is server-class integrations** — surfaces that bring meaningful state, structured resources, or many related Tools at once. **MCP is not the path for wrapping single CLIs** — for that, agents use the built-in `run_shell` Tool against a per-Agent command allowlist. Process lifecycle is reference-counted by Harness bindings: the server starts when the first Agent that binds it appears in the **Agent Catalog**, and stops when the last such Agent unbinds or is destroyed.

**Capability**:
A named, reusable unit of agent ability — a **Skill**, **Prompt Snippet**, **Tool**, or **MCP Server**. Has an **origin** tag. An Agent's **Agent Harness** is *not* a Capability — it is the on-disk artifact of an Agent (one per Agent, not reusable, indexed in the **Agent Catalog**, not the **Capability Registry**). The Harness *binds* Capabilities by name; the Capabilities themselves are the reusable units.

**Personal-origin Capability**:
Tagged as portable. Travels with the user across companies. Carries no company-specific knowledge.

**Workplace-origin Capability**:
Tagged as company-bound. Implements adapters for the company's systems (e.g., ADO MCP, internal allowlists, company vocabulary). Stays at the company on departure.

**Capability Registry**:
The flat, named set of all loaded **Capabilities** (Skills, Prompt Snippets, Tools, MCP Servers; both origins) at a deployment. **Agent Harnesses** resolve binding names against it when a Run starts. Distinct from the **Agent Catalog**, which indexes Agents (each persisted as one Harness).

**Capability Manifest**:
The on-disk description of a **Capability** — schema, content (for Skills), MCP endpoint (for MCP Servers), origin tag, **Provider Hints**, and **Capability Compatibility** constraints. A Capability is the runtime entity resolved against the **Capability Registry**; its Manifest is the document that defines it.

**Provider Hint**:
Typed escape-hatch metadata on a **Capability Manifest** carrying per-provider concessions (e.g., Anthropic `cache_control` placement, OpenAI strict-mode requirement, Gemini schema subset). Read by the **ModelGateway** at Run start to produce a provider-shaped artifact.

**Capability Compatibility**:
Manifest-declared requirements that a **Run** validates before starting. Two axes:
- **Model-side**: *requires tool_use*, *requires reasoning visibility*, *requires ≥200k context*. Validated against the chosen model.
- **System-side**: *requires `gog` binary at $PATH*, *requires Docker daemon running*, *requires `$AZURE_TOKEN` env var*. Validated against the deployment environment.

Prevents silent under-delivery when a Capability cannot be honored. MCP server activation also gates on system-side compatibility — a server that requires `gog` does not start (and surfaces a clear error) if `gog` is missing.

**Tool-use Loop**:
The iterative cycle inside a **Run**: model emits a tool call → Hive executes the bound **Tool** or **MCP** call → result returns to the model → model continues. Universal across providers; the **ModelGateway** normalizes the wire shape.

**Audit Log**:
Append-only record of **what users and agents did** — Capability invocations within Runs (tool calls, MCP calls, Skill loads, Memory writes), Permission decisions, Secrets access (the reference and source, never the value), MCP server lifecycle, Agent lifecycle (created/updated/destroyed by Agent Manager), backend invocations (CLI spawn args), user actions (messages sent, approvals, model overrides, Harness binding edits). Primary purpose: answering "what happened, who triggered it, when?" Schema reserves fields for v1.1 tamper-evidence (hash chain, signature) without requiring data migration. Replay-as-executable-history is an explicit non-goal for v1. **System-internal diagnostics (parse errors, watcher events, startup chatter, performance) live in the Trace Log — not here.** See [ADR-0004 "Audit vs trace"](docs/adr/0004-audit-log-design.md).

**Built on a subscribe model, not a push API.** Other modules do **not** call `audit.record(...)`. Each module owns its typed event stream (Run emits `RunEvent`, Permission emits `PermissionDecision`, Secrets emits `SecretAccess`, MCP emits server-lifecycle events, Memory emits `MemoryWrite`, the Capability Registry emits registration events, the Agent Manager emits lifecycle events). The Audit Log is a subscriber: it consumes these streams, normalizes each into a common `AuditEvent` row, and persists. Nothing reaches *into* Audit; Audit reaches *out*. This is the same pattern that lets the UI, future observability exporters, and any future training-data dumper plug in without touching emitters.

**Trace Log**:
Pino-backed JSONL diagnostic stream at `~/.hive/logs/daemon.log`. Captures the system's view of its own operation: malformed-manifest skip, filesystem watcher errors, daemon startup phases, hot-reload rescans, gateway latency, CLI subprocess output capture, anything you'd want to see in a stack trace. Modules import a singleton (`src/lib/log.ts`) and write structured records directly — *no* subscribe pattern, because diagnostic context is best emitted at the call site with full local state. Trace answers "why didn't this work?"; Audit answers "what did the user/agent do?". The two stores are intentionally separate — different schemas, different retention, different consumers.

**Configuration**:
Deployment-wide application settings — audit retention, UI Appearance (theme mode, per-mode palette + typography, accessibility toggles), daemon port, log level, etc. — stored at `~/.hive/config.yaml` and managed by the **Config module**. Reactive: modules subscribe to specific keys via `config.watch(key, listener)` and react to changes without restart. Settings UI mutations and external edits to `config.yaml` flow through the same change pipeline. **Per-Agent settings** (the authored model preference, capability bindings, prompt) live on the **Agent Harness**, not in Configuration. The one exception is a user's per-Agent model default chosen in the UI: it is neither Harness nor Config but a small deployment-level per-Agent store, resolved ahead of the Harness's authored model ([ADR-0013](docs/adr/0013-per-agent-model-default-resolution-tier.md)). **Secrets** (API keys, OAuth tokens) live in the Secrets primitive, not in Configuration. Boundary rule: Config is for things every component of the deployment may read; Agent-specific things stay with the Agent; sensitive values stay in Secrets.

**Librarian Memory Model**:
Leading candidate (not locked). Per-**Agent** memory in a deterministic format + a per-Agent INDEX. Cross-agent reads are on-demand and INDEX-guided (via the **Agent Catalog**). No auto-promotion.

## Runtime

**Daemon**:
The long-running Hive process that hosts the **Agent Catalog**, **Runs**, **Memory**, **Capability Registry**, and **Audit Log**. Exposes HTTP + WebSocket on `localhost`. Per ADR-0002, Bun + Hono. The same Daemon binary serves the desktop **Shell**, headless servers, and CLI clients.

**Shell**:
The desktop presentation layer (Electron, per ADR-0002) that wraps the UI in a real window and spawns the **Daemon** as a child process. Owns tray icon, native notifications, deep links, single-instance lock, and auto-update. Distinct from the Daemon — removing the Shell does not stop the Daemon.

**Headless Mode**:
The **Daemon** running without a **Shell**. The only mode for servers, dev tunnels, CI, and CLI use. Same binary, same data, no window.

**ModelGateway**:
The single Hive-owned interface every LLM completion call passes through. Normalizes streaming events, tool-use representation, and provider knobs (thinking, caching, multimodal). Insulates Hive from whichever **Provider Adapter** library backs it. Per ADR-0002, currently delegates to `@earendil-works/pi-ai`; swappable. **Only the `native` Agent Backend uses the ModelGateway.** CLI-driven backends (`claude-code`, `codex`) never touch it — their model auth, tool dispatch, and conversation state are internal to the CLI subprocess.

**Agent Backend**:
The runtime that executes an Agent's **Run**. The **Agent Harness** carries an authored default; like model and effort it is user-overridable per conversation (and promotable to the Agent default), so a **Worker Agent** can run `native` in one Thread and CLI-driven in another. Two kinds in v1:
- **`native`** — Hive's own Run executor (ModelGateway + bound Capabilities + Memory + Permission System).
- **CLI-driven** (`claude-code`, `codex`, future external agent CLIs) — Hive spawns the external agent CLI and hands it the task: Thread history + Memory + the user's latest message, plus the Agent's bound **Skills** *projected* into the CLI's native skill format and the authored prompt injected as the CLI's instructions — the CLI's *own* progressive disclosure then matches them, so Hive runs no skill disclosure on this path. Tool and MCP projection are deferred. Hive streams the CLI's stdout as `RunEvent`s, captures its result, and writes back to Memory + Thread.

The seam is the Run module's interface: `startRun(thread, agent) → AsyncIterable<RunEvent>`. Native and CLI-driven backends are interchangeable behind it — UI, CLI, audit, and Thread persistence see the same event shape. The **Root Agent** and **Agent Manager** are always `native` (their dispatch and lifecycle Tools are in-process built-ins a CLI cannot invoke); only **Worker Agents** may switch backend.

**Provider Adapter**:
The per-provider translation unit that maps Hive's canonical message + tool format to one provider's wire shape (Anthropic Messages, OpenAI Responses, Gemini, Bedrock, Ollama, …). Composed by the **ModelGateway**. Owns auth, model catalog, thinking-effort mapping, prompt-cache placement, and stream-event normalization for that provider.

## Relationships

- An **Agent** = identity + **Agent Harness** + **Memory** (keyed by Agent identity)
- An **Agent** has a **Domain** (a logical label, not a structural partition)
- An **Agent** owns zero or more **Threads**
- A **Run** binds an Agent to a Thread for one execution
- A **Skill** is typically Personal-origin; an Agent Harness opts into specific skills
- A **Prompt Snippet** is consumed by the **Agent Manager** at spawn/refresh time; it is never bound to a target Agent and never enters a target Agent's runtime context
- A **Tool** may be Personal-origin (portable) or Workplace-origin (per-company, often via MCP)
- The **Root Agent** is the user's conventional entry point and the only Agent that may dispatch tasks to other Agents; the **Agent Manager** is the only Agent that may create/update/destroy Agents; all other Agents are **Worker Agents** (do work, cannot dispatch, cannot manage)
- The **Capability Registry** is loaded at deployment startup; per-agent data (**Memory**, INDEX, **Threads**) is loaded per-Run against the (Agent, Thread) pair
- The **Agent Catalog** indexes agents; each agent's data lives in its own partition keyed by Agent identity
- A **Capability Manifest** defines a **Capability**; **Provider Hints** and **Capability Compatibility** live on the Manifest
- Every LLM completion call inside a `native`-backend **Run** flows: Run → **ModelGateway** → **Provider Adapter** → provider SDK; CLI-driven backends bypass this entirely (the CLI subprocess manages its own LLM calls)
- An **Agent Backend** is selected per-Agent on the **Agent Harness**; the Run module's interface is the seam where `native` and CLI-driven backends are interchangeable
- The **Daemon** hosts Runs and the Registry; the **Shell** is one of several clients (alongside browser tabs and CLI) that connect to the Daemon over HTTP/WS
- **Headless Mode** = Daemon without Shell; all other modes are Daemon-plus-client

## Reference projects

External agent systems that inform Hive's design. We borrow specific patterns from them; we are not cloning either.

**OpenClaw** — [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw). Public, TypeScript personal-AI assistant. Multi-platform (Telegram, Discord, Slack, WhatsApp, Signal, voice). Built on the `@earendil-works/pi-*` package family (pi-ai, pi-agent-core, pi-coding-agent, pi-tui, pi-web-ui). Local clone for direct inspection: `E:\dev\GitRepos\openclaw`. Workspace lives at `~/.openclaw/workspace/agents/<agent-id>/`.
- Reference for: **capability layer** (skills, plugins, MCP integration); **secrets / auth** (`SecretRef` with `env`/`file`/`exec` sources; ApiKey/Token/OAuth credential taxonomy; per-Agent auth profiles with `main` fallback via read-through inheritance; `copyToAgents` portability flag; round-robin usage stats + cooldown tracking); channel/transport architecture; `doctor`/diagnostics with stable probe reason codes; MCP watchdog patterns.
- Where Hive diverges: **per-Agent Memory partition** (OpenClaw shares one workspace across channels); **explicit Personal/Workplace origin tagging** on Capabilities and secrets (vs. OpenClaw's single `copyToAgents` boolean); **frozen Agent Harness** authored by the Agent Manager (vs. OpenClaw's live agent config).

**Hermes Agent** — [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Public, Python self-improving agent from Nous Research. Multi-platform (CLI + Telegram/Discord/Slack/WhatsApp/Signal/Email gateway). Seven terminal backends (local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox); serverless hibernation. Ships an explicit OpenClaw migration command (`hermes claw migrate`) — the two ecosystems are sibling projects, not competitors. Local clone for direct inspection: `E:\dev\GitRepos\hermes-agent`. Workspace lives at `~/.hermes/`.
- Reference for: **memory model candidate** (tiered persistence, autonomous skill creation from experience, FTS5 session search with LLM summarization, Honcho dialectic user modeling); provider-adapter pattern (per-provider files under `agent/`); context compression and budget allocation (`context_compressor.py`, `context_engine.py`); scheduled automations via built-in cron; multi-backend execution surfaces.
- Where Hive diverges: **per-Agent Memory keyed by Agent identity** (Hermes builds one cross-session user model); **Agent Manager explicitly authors and refreshes Agent Harnesses** (Hermes' self-improvement is autonomous and continuous; Hive gates it through explicit Agent Manager Runs); first-class Personal/Workplace origin tagging for portability across employers.

**work-claw** — *Microsoft-internal* feature inventory, **not a public reference project and not an architectural source.** [`docs/inventory-workclaw.md`](docs/inventory-workclaw.md) catalogues ~150 features from that internal system and triages them as starting hypotheses for what Hive might build (per ADR-0001). Use it as a *feature checklist* against scenarios, never as a design pattern. Cite OpenClaw or Hermes for architectural references, not work-claw.

## Flagged ambiguities

- **"Persistent vs. ephemeral agent"** was originally proposed as a fundamental distinction. Resolved: it's not. Both share `Agent Harness + Memory`. The difference is whether the agent is kept after the task — a deployment choice, not an identity.
- **"Agent Harness template vs instance"** (ADR-0001 blocker #6). Resolved: there is no live template. The Harness *is* the instance — a frozen artifact written by the Agent Manager. The "template-like" reuse is supplied by **Prompt Snippets** (a separate Capability kind) that the Agent Manager consults at spawn. Snippet edits do not propagate; refreshing an agent's prompt requires an explicit Agent Manager Run.
- **"Domain"** is locked to the _logical focus area_ sense. It is abstract — not a structural partition. Resources an agent can reach (repos, files, MCPs) are determined by the **Agent Harness**, not by Domain.
- **"Hermes-style tiered memory" vs. "Librarian model"** — open. Likely composable (librarian as per-Agent partition, tiered shape within each agent's memory). Deferred to a dedicated memory session.
- **Our "Agent" vs. industry "agent"** — industry usually means the _running_ thing (LLM + loop). Ours is the _persistent_ pair (Agent Harness + Memory). The running thing is **Run**. Closest industry analogue: OpenAI's Assistant.

## Deferred decisions

- **Memory model details** (events vs. prose, tiering, promotion rules, INDEX shape, INDEX maintenance). Dedicated session pending.
- **Identity continuity on rename / clone / repurpose** (memory follow? fork? reference-share?).
- **Agent Manager authority boundary** (autonomous creation vs. user-approved).

## Example dialogue

> **User:** "Make a coding agent focused on odsp-web."
> **Root Agent:** Delegates to **Agent Manager**.
> **Agent Manager:** Clones the `code` **Agent Harness**, names the new agent `code-odsp`, sets its **Domain** to "odsp-web coding", binds the relevant repo/MCP Capabilities, creates a fresh **Memory** partition keyed by `code-odsp`, and adds an entry to the **Agent Catalog**. Returns: "Agent `code-odsp` ready."
> **User (later):** "Ask code-odsp to fix the flaky test — and it might need to check augloop too."
> **Root Agent:** Opens (or reuses) a **Thread** with `code-odsp` and starts a **Run**. The Run loads the `code` Agent Harness, the code-odsp Memory, and the Thread's prior history. The agent's Domain says it focuses on odsp-web, but its Harness Capabilities also reach augloop — so it can do both. Writes back to memory at completion.
