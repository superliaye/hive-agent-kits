# Hive — Capability Deploy-Manager

A control surface for managing **agent capabilities** across one or more
**Sources** — git repositories of **Capabilities** that conform to Hive's
capability format. Hive **syncs** each Source at runtime and **deploys** selected
**Capabilities** into the **CLI homes** of Claude Code and Codex — with visibility,
explicit control, and easy reconfigure on top of what the upstream `agent-kit`
wizard does. Priority #1 is managing and deploying Capabilities at scale; Hive's
own AI conversations composed from those Capabilities are **deferred (#2)** — see
that section below, which keeps (does not delete) the agent vocabulary.

## Language (current — the deploy-manager)

**Source**:
A tracked git repository of **Capabilities** — a *kit* of capabilities — that
conforms to Hive's capability format. Hive manages one or more Sources; each is
**synced** independently into its own **Mirror**. A Source can be activated,
deactivated, and deleted. Hive tracks each Source's last synced revision; there is
no app-level version pinning (every Source tracks its own tip). How multiple active
Sources reconcile (a bundled default Source, ordering, duplicate handling) is a
product decision recorded in the multi-source ADR, not here.
_Avoid_: "the repo", "the package" (a Source is the tracked, conformant
repository). "Kit" stays fine informally — a Source is a kit of Capabilities — but
"Source" is the precise term once more than one is in play.

**Capability**:
A deployable unit in a **Source**. Five kinds, the upstream taxonomy:
- **instruction** — a body of rules that is concatenated into a CLI's global
  instruction file (whole-file ownership — a Deploy overwrites it).
- **skill** — an on-demand technique folder copied into a CLI's skills location.
- **agent** (lowercase, Source-namespaced) — a CLI **subagent** artifact: a Claude
  subagent file, or its translation for Codex. **This is NOT the title-case
  Agent** of the deferred #2 vocabulary (a persistent Hive identity). The two
  share a word and nothing else — `agent` here is a deployable Capability a
  Source ships; **Agent** there is a Hive entity that does not exist in #1. When the
  word matters, say "the `agent` capability" vs "the Hive **Agent**".
- **plugin** — a Claude Code plugin, installed via the Claude CLI (Claude-only).
- **bundle** — a wrapper around an external installer that vends its own skills.

A **snippet** is a build-time *include* shared across Capabilities, not a deploy
kind. Capabilities may be organized under nested **@-namespaces** for browsing;
the namespace is display-only — a Deploy flattens every Capability to its leaf
name, which must be unique within its kind.
_Avoid_: "artifact" alone (a Capability is the named, deployable unit).

**CLI home**:
A global directory a CLI reads its configuration and capabilities from. Each
deploy **target** (Claude, Codex) maps to CLI homes; a target's skills, agents,
and instruction file may live in different homes (Codex's user skills, notably,
live apart from the rest of its config).
_Avoid_: "config dir" (CLI home is the specific per-CLI global root a Deploy writes to).

**Sync**:
Fetching the latest tree of a **Source** into that Source's private **Mirror** — a
runtime refresh with no rebuild. Each active Source is synced independently. A Sync
records the exact upstream revision it fetched and keeps the previous Mirror until
the new one is fully in place. A Sync that fails (offline, rate-limited, or a bad
download) keeps the last good Mirror and is surfaced as a distinct freshness state —
never as "up to date".

**Mirror**:
A **Source**'s private, read-only copy under the Hive home — what a **Deploy** reads
its artifacts from. Each Source has its own Mirror; Hive never physically merges
Sources into one tree (the unified view across Sources is computed, not stored).
Distinct from the **CLI homes** a Deploy writes to.

**Deploy**:
Writing a selected set of **Capabilities** from the active Sources' **Mirrors**
into the **CLI homes**, reproducing the upstream contract with full fidelity.
Always explicit (never automatic). Ordered best-effort: each kind is applied in
turn and the **Deployment Ledger** records what actually landed, so a partial
failure leaves a consistent record and a re-Deploy is idempotent.

**Deployment Ledger**:
The shared, durable record of what is currently deployed on the machine — reused
for interop with the `agent-kit` CLI (both write it). A name in the Ledger is
Hive-owned and may be reconciled away when deselected; anything on disk but absent
from the Ledger is the user's and is never touched. Skills and `agent`
capabilities are pruned by name on reconcile; plugins and bundles are never
auto-removed (Hive only hints). Which **Source** a deployed name came from is
recorded in Hive-private deploy metadata, never in this interop Ledger.

**Preset**:
A named selection of **Capabilities** from a **Source**. Selecting a Preset seeds a
**Selection**. Presets may extend one another (the child's set unions the
parent's). Hive consumes Presets; authoring them is upstream (no preset editor).

**Selection**:
The user's chosen set to **Deploy** — a Preset seed plus individual toggles plus
the target CLIs. Resolves to a concrete per-kind set of names across the active
**Sources**. How a cross-Source name clash resolves is a product decision recorded
in the multi-source ADR.

**Deploy Diff**:
The difference between the currently-deployed state and a pending **Selection**:
what would be **added**, **removed**, or **changed**. *Changed* is detected by
content, not just by name — a Capability whose upstream body changed under the
same name still shows as changed. The Diff also warns when a Deploy would replace a
user-authored instruction file (e.g. an existing hand-written global instruction
file the user owns). How it surfaces a duplicate displaced across **Sources** is a
product decision recorded in the multi-source ADR.

## Audit and trace (current)

**Audit Log**:
Append-only record of **what the user did**. In #1 the single user action is a
**Deploy**: one audit entry per Deploy, carrying references only (the synced
revision, per-kind counts, the target CLIs) — never file contents or secrets. A
Deploy has no Run or Agent, so those correlation fields are empty. Built on a
subscribe model: the deploy path emits a typed event and the Audit module
consumes it; nothing calls Audit directly. See [ADR-0004](docs/adr/0004-audit-log-design.md).

**Trace Log**:
The system's diagnostic stream — **Sync** resolution and download, extraction,
per-Capability deploy results, installer output, watcher and startup chatter.
Modules write structured records at the call site. Trace answers "why didn't this
work?"; Audit answers "what did the user do?". The two stores are intentionally
separate.

## Runtime (current)

**Daemon**:
The long-running Hive process that hosts the **Mirror**, **Sync**, **Deploy**, the
**Deployment Ledger** reader, and the **Audit Log**. Exposes HTTP on `localhost`.
Bun + Hono (ADR-0002). The same binary serves the desktop **Shell** and headless use.

**Shell**:
The desktop presentation layer (Electron, ADR-0002) that wraps the UI in a window
and spawns the **Daemon** as a child process. Removing the Shell does not stop the
Daemon.

**Headless Mode**:
The **Daemon** running without a **Shell** — the mode for servers, CI, and CLI use.

**Agent Backend**:
A CLI that is a **Deploy** target — `claude-code` (Claude Code) or `codex`
(Codex). The Settings UI surfaces each backend's availability and its provider
**auth** state (whether a Hive-injected API key is operative, or the CLI uses its
own ambient login).

**Backend Readiness**:
A per-backend projection joining a backend's availability with the auth state of
its provider, feeding the Settings "Backends" page.

**Configuration**:
Deployment-wide settings — audit retention, UI Appearance (theme mode, palette,
typography, accessibility), daemon port, log level — managed by the **Config
module** and reactive (modules subscribe to keys). **Secrets** (API keys, OAuth
tokens) live in the Secrets primitive, not in Configuration.

## Relationships (current)

- A **Sync** fetches a **Source** into that Source's **Mirror**; a **Deploy** writes
  selected **Capabilities** from the active Sources' Mirrors into the **CLI homes**
  of the chosen targets.
- A **Preset** seeds a **Selection**; individual toggles and target CLIs adjust it.
- A **Deploy Diff** compares the current deployed state (the **Deployment Ledger**
  + on-disk content) to a pending **Selection**.
- The **Deployment Ledger** is the ownership boundary: Hive-owned names may be
  reconciled; user files are untouched.
- A **Capability** is one of five kinds; the lowercase `agent` capability is a CLI
  subagent artifact and is **not** the deferred Hive **Agent**.

---

## Deferred (#2 — agent scenarios)

The vocabulary below describes Hive's own AI-conversation scenarios — a Hive that
composes the Capabilities above into running Agents. **This is parked, not
deleted.** None of these entities exist in the #1 deploy-manager. The title-case
**Agent** here is distinct from the lowercase `agent` **Capability** kind above.

**Agent** (deferred):
A persistent identity with an **Agent Harness** + a **Memory** partition. The
*persistent* thing, not the running thing (the running thing is a **Run**). Each
Agent has a **Domain** (logical focus area). Distinct from the `agent` Capability
kind, which is a deployable CLI subagent artifact, not a Hive identity.

**Agent Harness** (deferred):
An Agent's on-disk artifact — the file that defines it. Binds **Capabilities** by
name; carries a chosen **Agent Backend** and its config (system prompt, bound
**Skills** + **MCP Servers**, model + thinking-effort preferences, working
directory). Authored by the **Agent Manager**; frozen until an explicit edit. Each
**Run** snapshots it at start.

**Run** (deferred):
One execution of an **Agent** on a **Thread** — from invocation to completion,
possibly many model turns and tool calls. Drives a vendor Agent SDK whose stream
is folded into `RunEvent`s.

**Thread** (deferred):
A persistent conversation between a user (or agent) and an **Agent** — what the UI
would surface as a conversation. Holds message history; has a **Title**, a
**Conversation Lifecycle** (active / archived / deleted), and a derived **Thread
Status**.

**Memory** (deferred):
Per-**Agent** persisted data keyed by Agent identity. Format deferred (the
Librarian candidate: a deterministic per-Agent store + INDEX).

**Domain** (deferred):
The logical focus area an **Agent** specializes in — abstract, not a structural
partition.

**Capability Registry** (deferred):
The flat, named set of all loaded **Capabilities** an Agent's Harness resolves
binding names against at Run start. Distinct from the **Agent Catalog**.

**Agent Catalog** (deferred):
The directory of **Agents** at a deployment — one entry per Agent (name, Harness,
Domain, state). Distinct from the **Capability Registry**.

**Root Agent / Agent Manager / Worker Agent** (deferred):
Agent roles. **Root** is the user's entry point and the only Agent that may
dispatch to other Agents. The **Agent Manager** is the only Agent that may create,
configure, and destroy Agents. A **Worker Agent** is any other Agent — does work,
cannot dispatch, cannot manage.

**Skill / Prompt Snippet / Tool / MCP Server** (deferred):
The Capability kinds an **Agent Harness** binds in #2 — an on-demand technique, a
reusable prompt block consulted by the Agent Manager, a callable function, and an
external Model-Context-Protocol integration. (In #1 these map onto the Kit's
`skill` / `snippet` / plugin-and-bundle Capabilities the user deploys to a CLI.)

### Deferred flagged ambiguities

- **The `agent` Capability kind vs the Hive Agent.** Kept distinct by namespace +
  case: lowercase Kit-namespaced `agent` (a deployable CLI subagent Capability,
  #1) vs title-case **Agent** (a persistent Hive identity, #2). This collision is
  flagged for human ratification; the default above (keep both, distinguish by
  namespace + case) is in force.
- **"Our Agent vs industry agent"** — industry usually means the running thing;
  ours (deferred) is the persistent pair (Harness + Memory). The running thing is
  the **Run**.

### Deferred decisions

- **Memory model details** (events vs prose, tiering, promotion, INDEX shape).
- **Identity continuity on rename / clone / repurpose.**
- **Agent Manager authority boundary** (autonomous vs user-approved).

## Reference projects

External systems that inform Hive's design. We borrow specific patterns; we are
not cloning any.

**my-agent-kits** — [github.com/superliaye/my-agent-kits](https://github.com/superliaye/my-agent-kits).
The original **Source** of Capabilities and the `agent-kit` CLI whose deploy
contract Hive reproduces. The deploy contract (target locations per kind, the
include/sidecar/translation rules, the Deployment Ledger schema) is read from a
pinned clone — see AGENTS.md "Reference projects" for the local path and the exact
verified SHA.

**OpenClaw** — [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw).
Public TypeScript personal-AI assistant on the `pi-*` package family. Reference
(mostly for deferred #2) for: capability layer, secrets/auth taxonomy, channel
architecture, `doctor`/diagnostics probe reason codes.

**Hermes Agent** — [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
Public Python self-improving agent from Nous Research. Reference (mostly for
deferred #2) for: tiered memory candidate, provider-adapter pattern, context
compression, scheduled automations.

**work-claw** — *Microsoft-internal* feature inventory, **not a public reference
and not an architectural source.** [`docs/inventory-workclaw.md`](docs/inventory-workclaw.md)
is a feature checklist only; cite OpenClaw or Hermes for architecture, never work-claw.
