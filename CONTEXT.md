# Hive — Agent Architecture

A portable personal AI system. **Capabilities** (skills, tools, MCP, Agent Harness templates) carry an **origin** tag (Personal — travels with the user; Workplace — lives at the company). Per-agent runtime data (memories, INDEX, Threads) accumulates separately at the deployment. Goal: 100x productivity carried with the user across companies and repos, without losing focus per domain.

## Language

**Agent**:
An identity with an **Agent Harness** + a **Memory** partition keyed by that identity. Mutable — can be renamed, repurposed, cloned, destroyed. Each agent has a **Domain** (logical focus area). Our **Agent** is the persistent thing (not the running thing). The running thing is a **Run**.
_Avoid_: "AI assistant", "bot" (too generic).

**Agent Harness**:
An agent's capability bundle — the agent's **own** complete system prompt (frozen text, written by the **Agent Manager** at spawn, drawing on **Prompt Snippets**) + identity + bound **Skills** + bound **Tools** + bound **MCP Servers**. A file/document. The prompt itself is monolithic and is not reassembled at Run start; only the bound Capabilities are resolved against the **Capability Registry** at Run start. Updating the prompt requires an explicit Agent Manager Run.
_Avoid_: "Harness" alone (we always prefix with "Agent"), "Persona" (implies only prompt).

**Memory**:
Per-**Agent** persisted data the agent reads and writes. Keyed by Agent identity, not by Domain. Format intentionally deferred — see Deferred Decisions.

**Domain**:
The logical focus area an **Agent** specializes in. Abstract — not a hardcoded partition. An agent whose Domain is "odsp-web coding" may still access augloop or other repos as secondary references; Domain describes _what the agent cares about_, not _what it can reach_. Access is determined by the **Agent Harness**'s bound Capabilities, not by Domain.

**Thread**:
A persistent conversation between a user (or another agent) and an **Agent**. Holds message history. One Agent can have multiple Threads, in parallel or sequentially. Modeled after OpenAI's Thread.

**Run**:
One execution of an **Agent** on a **Thread**. Spans from invocation to completion — may include multiple model turns and tool calls. Multiple Runs of the same Agent (on the same or different Threads) may execute concurrently. Modeled after OpenAI's Run.

**Agent Catalog**:
The directory of agents at a deployment. One entry per **Agent**: name, **Agent Harness**, **Domain** (label), current state. Used for routing, discovery, and lifecycle management. A consumer reads it to answer "what agents exist and which one should I send this to?"

**Root Agent**:
The user's entry-point **Agent**. Has system overview, handles simple requests directly, dispatches harder work to other agents.

**Agent Manager**:
A specialized **Agent** that creates, configures, clones, and destroys other agents. Separated from the **Root Agent** for focus reasons — agent design is heavy context.

**Skill**:
An on-demand technique file an agent opts into. Loaded only when matched; not always-on context. A **Capability** with Personal-origin (typically).

**Prompt Snippet**:
A reusable block of prompt text — voice rules, coding practices, review standards, domain conventions, etc. A **Capability** with an origin tag. **Not** loaded into any running agent's context. Consumed only by the **Agent Manager** at agent-creation (or prompt-refresh) time as reference material when authoring another agent's Harness prompt. The Agent Manager may adopt verbatim, paraphrase, combine, or omit. Snippets are advisory inputs to prompt authoring; they are never live includes.
_Avoid_: "Persona", "Role", "Soul", "Instructions" — those describe content categories, not the kind. The kind is "Prompt Snippet"; categories (voice, practice, convention, …) live on the manifest if useful.

**Tool**:
A function an agent can call. A **Capability**. Either **built-in** (TypeScript handler in the Hive daemon source tree — Personal-origin, ships with Hive itself, has direct in-process access to Hive internals like Memory and Run spawning) or **MCP-sourced** (surfaced from a configured **MCP Server**; origin inherits from the server: a personal MCP server carries Personal-origin Tools, a company MCP server carries Workplace-origin Tools). **User extension of Tools happens by adding MCP servers, not by dropping TypeScript files into a data directory** — the process boundary is what gives user-installed Tools a trust model.

**MCP Server**:
An external process providing tools and resources via the Model Context Protocol. A **Capability**. Origin is per-server: a personal MCP server (a `gh` wrapper you wrote, a local Ollama bridge) is Personal-origin and travels with you; a company MCP server (ADO, internal allowlists) is Workplace-origin and stays. Because **Tools** are restricted to built-in (in the daemon source tree) or MCP-sourced, **MCP is the only path for user-installed Tools** — it carries both Personal and Workplace extensions. Process lifecycle is reference-counted by Harness bindings: the server starts when the first Agent that binds it appears in the **Agent Catalog**, and stops when the last such Agent unbinds or is destroyed.

**Capability**:
A named, reusable unit of agent ability — a **Skill**, **Prompt Snippet**, **Tool**, **MCP Server**, or **Agent Harness** template. Has an **origin** tag.

**Personal-origin Capability**:
Tagged as portable. Travels with the user across companies. Carries no company-specific knowledge.

**Workplace-origin Capability**:
Tagged as company-bound. Implements adapters for the company's systems (e.g., ADO MCP, internal allowlists, company vocabulary). Stays at the company on departure.

**Capability Registry**:
The flat, named set of all loaded **Capabilities** (both origins) at a deployment. Agent Harnesses resolve names against it when a Run starts.

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
Append-only record of every **Capability** invocation within a **Run** (tool call, MCP call, Skill load, Memory read/write). Suitable for replay, inspection, and Trust/Permissions evaluation.

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
The single Hive-owned interface every LLM call passes through. Normalizes streaming events, tool-use representation, and provider knobs (thinking, caching, multimodal). Insulates Hive from whichever **Provider Adapter** library backs it. Per ADR-0002, currently delegates to `@earendil-works/pi-ai`; swappable.

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
- The **Root Agent** is the user's interface; the **Agent Manager** is the system's interface for agent lifecycle
- The **Capability Registry** is loaded at deployment startup; per-agent data (**Memory**, INDEX, **Threads**) is loaded per-Run against the (Agent, Thread) pair
- The **Agent Catalog** indexes agents; each agent's data lives in its own partition keyed by Agent identity
- A **Capability Manifest** defines a **Capability**; **Provider Hints** and **Capability Compatibility** live on the Manifest
- Every LLM call inside a **Run** flows: Run → **ModelGateway** → **Provider Adapter** → provider SDK
- The **Daemon** hosts Runs and the Registry; the **Shell** is one of several clients (alongside browser tabs and CLI) that connect to the Daemon over HTTP/WS
- **Headless Mode** = Daemon without Shell; all other modes are Daemon-plus-client

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
