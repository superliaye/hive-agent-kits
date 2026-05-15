# Hive — Agent Architecture

A portable personal AI system. **Capabilities** (skills, tools, MCP, Agent Harness templates) carry an **origin** tag (Personal — travels with the user; Workplace — lives at the company). Per-agent runtime data (memories, INDEX, Threads) accumulates separately at the deployment. Goal: 100x productivity carried with the user across companies and repos, without losing focus per domain.

## Language

**Agent**:
An identity with an **Agent Harness** + a **Memory** partition keyed by that identity. Mutable — can be renamed, repurposed, cloned, destroyed. Each agent has a **Domain** (logical focus area). Our **Agent** is the persistent thing (not the running thing). The running thing is a **Run**.
_Avoid_: "AI assistant", "bot" (too generic).

**Agent Harness**:
An agent's capability bundle — system prompt + identity + selected **Skills** + bound **Tools** + bound **MCP Servers**. A file/document. Resolution against the **Capability Registry** happens at Run start.
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

**Tool**:
A function an agent can call. A **Capability**. May be defined natively (Personal-origin) or provided by an **MCP Server** (Workplace-origin).

**MCP Server**:
An external process providing tools and resources via the Model Context Protocol. A **Capability**; typically Workplace-origin.

**Capability**:
A named, reusable unit of agent ability — a **Skill**, **Tool**, **MCP Server**, or **Agent Harness** template. Has an **origin** tag.

**Personal-origin Capability**:
Tagged as portable. Travels with the user across companies. Carries no company-specific knowledge.

**Workplace-origin Capability**:
Tagged as company-bound. Implements adapters for the company's systems (e.g., ADO MCP, internal allowlists, company vocabulary). Stays at the company on departure.

**Capability Registry**:
The flat, named set of all loaded **Capabilities** (both origins) at a deployment. Agent Harnesses resolve names against it when a Run starts.

**Librarian Memory Model**:
Leading candidate (not locked). Per-**Agent** memory in a deterministic format + a per-Agent INDEX. Cross-agent reads are on-demand and INDEX-guided (via the **Agent Catalog**). No auto-promotion.

## Relationships

- An **Agent** = identity + **Agent Harness** + **Memory** (keyed by Agent identity)
- An **Agent** has a **Domain** (a logical label, not a structural partition)
- An **Agent** owns zero or more **Threads**
- A **Run** binds an Agent to a Thread for one execution
- A **Skill** is typically Personal-origin; an Agent Harness opts into specific skills
- A **Tool** may be Personal-origin (portable) or Workplace-origin (per-company, often via MCP)
- The **Root Agent** is the user's interface; the **Agent Manager** is the system's interface for agent lifecycle
- The **Capability Registry** is loaded at deployment startup; per-agent data (**Memory**, INDEX, **Threads**) is loaded per-Run against the (Agent, Thread) pair
- The **Agent Catalog** indexes agents; each agent's data lives in its own partition keyed by Agent identity

## Flagged ambiguities

- **"Persistent vs. ephemeral agent"** was originally proposed as a fundamental distinction. Resolved: it's not. Both share `Agent Harness + Memory`. The difference is whether the agent is kept after the task — a deployment choice, not an identity.
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
