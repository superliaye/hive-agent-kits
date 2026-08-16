# Hive — Capability Deploy-Manager

A control surface for managing **agent capabilities** across one or more
**Sources** — located collections of **Capabilities** that conform to Hive's
capability format. Hive **syncs** each Source at runtime and **deploys** selected
**Capabilities** into the **CLI homes** of Claude Code and Codex — with visibility,
explicit control, and easy reconfigure on top of what the upstream `agent-kit`
wizard does. Priority #1 is managing and deploying Capabilities at scale; Hive's
own AI conversations composed from those Capabilities are **deferred (#2)** — see
that section below, which keeps (does not delete) the agent vocabulary.

## Language (current — the deploy-manager)

**Source**:
A tracked collection of **Capabilities** — a *kit* of capabilities — that conforms
to Hive's capability format. A Source has a **Source Locator**: a git repository
plus revision and subpath, a working-tree root plus subpath on the Daemon machine, or
the bundled **Starter Source**. Hive manages one or more Sources; each is synced
independently into its own **Mirror**. A Source can be activated, deactivated, and
deleted. How multiple active Sources reconcile (the default Starter Source,
ordering, duplicate handling) is a product decision recorded in the multi-source
ADR, not here.
_Avoid_: "the repo", "the package" (a Source may select only a subpath, or may not
be backed by git at all). "Kit" stays fine informally — a Source is a kit of
Capabilities — but "Source" is the precise term once more than one is in play.

**Source Locator**:
The persisted description of where a **Source** is materialized from. A git
locator names a credential-free repository URL, a tracked ref or pinned commit,
and a subpath. A working-tree locator names an absolute repository root on the
**Daemon** machine and a subpath. The Daemon resolves the locator and records the
exact revision or snapshot identity; the **Shell** never acquires Source
credentials or reads Source files.

**Starter Source**:
The bundled **Source** shipped with Hive itself — the default, enabled on a fresh
install so a new user has deployable Capabilities out of the box, and
deactivatable to start from scratch. Unlike a remote Source it is **local**: its
Capabilities are copied from the bundle rather than fetched over the network, so
it works fully offline. Deleting it sticks (a fresh install seeds it once, never
re-seeds).
_Avoid_: implying it is fetched or versioned like a remote Source — it is the
in-app bundle.

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

**Conformance**:
The verdict on whether a **Source**'s **Capabilities** match Hive's capability
format — a `conformant` boolean plus a list of **conformance errors**, each a
located reason a capability fell short. Hive *reports* conformance; it never refuses
a non-conformant Source (a non-conformant Capability is surfaced, not rejected). The
format is a deliberately lenient superset of the upstream standards, so conformance
means "Hive and the target CLI will both accept this", not "passes the strictest
possible reading".

**CLI home**:
A global directory a CLI reads its configuration and capabilities from. Each
deploy **target** (Claude, Codex) maps to CLI homes; a target's skills, agents,
and instruction file may live in different homes (Codex's user skills, notably,
live apart from the rest of its config).
_Avoid_: "config dir" (CLI home is the specific per-CLI global root a Deploy writes to).

**Sync**:
Refreshing a **Source Locator** into that Source's private **Mirror** — a runtime
refresh with no rebuild. A git Sync uses the Daemon machine's ambient git
credentials and records the requested revision plus resolved commit. A working-tree
Sync snapshots the selected tree and records its HEAD, dirty state, and content
identity. The local **Starter Source** copies bundled content without a network
revision. Each active Source keeps its previous Mirror until the replacement is
fully in place. A failed Sync keeps the last good Mirror and is surfaced as a
distinct freshness state — never as "up to date".

**Mirror**:
A **Source**'s private, read-only copy under the Hive home — what a **Deploy** reads
its artifacts from. Each Source has its own Mirror; Hive never physically merges
Sources into one tree (the unified view across Sources is computed, not stored).
Distinct from the **CLI homes** a Deploy writes to.

**CapabilityKey**:
A Capability's **deploy identity**: its `(kind, leaf-name)`. A leaf name must be
unique within its kind inside a **CLI home**, so the CapabilityKey is what a Deploy
treats as "the same capability" — the unit precedence and duplicate-handling reason
over. Two **Sources** providing the same CapabilityKey are a duplicate to reconcile.
_Avoid_: "name" alone (the kind is part of the identity).

**ContentSha**:
The **content identity** of a Capability — a hash of its **Mirror** bytes. Two
Capabilities under the same **CapabilityKey** are "the same content" iff their
ContentSha matches **byte-for-byte** (no normalization). The signal that decides
**Merge** vs **Collision** across **Sources**.

**Variant**:
A distinct **ContentSha** under one **CapabilityKey**. Identical-ContentSha across N
Sources is a single Variant (a **Merge**, carrying N Source labels); a differing
ContentSha is a separate Variant. The aggregated catalog surfaces one entry per
Variant, so two entries may share a CapabilityKey.

**Shadowed Capability**:
A **Variant** that lost the **Source precedence** contest for its **CapabilityKey** —
a different-content sibling of the winning Variant. It is a **distinct, visible,
non-deployable catalog entry** badged "not deployed (duplicate)", **non-blocking**
(it never refuses a Deploy). Distinct from a **blocked** Capability (a malformed,
un-deployable single-Source duplicate): a Shadowed loser is well-formed; it simply
lost precedence.

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
The durable desired set to **Deploy** — CapabilityKeys plus target CLIs, persisted
by the **Daemon** with a revision. A **Preset** seeds that set; individual toggles
then mutate it without retaining Preset provenance. Selection changes never Deploy
automatically. Resolution chooses the winning active **Variant** for each selected
CapabilityKey; temporarily unavailable keys remain selected.

**Deploy Diff**:
The difference between the currently-deployed state and a pending **Selection**:
what would be **added**, **removed**, or **changed**. *Changed* is detected by
content, not just by name — a Capability whose upstream body changed under the
same name still shows as changed. The Diff also warns when a Deploy would replace a
user-authored instruction file (e.g. an existing hand-written global instruction
file the user owns). How it surfaces a duplicate displaced across **Sources** is a
product decision recorded in the multi-source ADR.

**Deployment State**:
Hive-private per-Capability, per-target metadata separating the last successful
applied content from the last Deploy attempt. It carries winning Source, deployed
ContentSha, rendered fingerprint, timestamps, operation ids, and bounded outcome
detail. It supplies provenance, verification, and failure detail without replacing
or extending the interoperable **Deployment Ledger**.

**Deployment Overview**:
The Daemon's point-in-time projection of Sources, catalog Variants, the durable
Selection, Deploy Diff, Deployment State, Deployment Ledger, and on-disk
verification. It is the Shell's authoritative daily view and carries an opaque
plan token that prevents a Deploy from applying a plan different from the one the
user reviewed.

## Audit and trace (current)

**Audit Log**:
Append-only record of **what the user did**. Audited deploy-manager actions include
Source mutations, durable Selection mutations, and Deploys. Events carry
references only: Source ids, Selection revision and per-kind counts, synced
revisions, and target CLIs — never Capability contents or secrets. These actions
have no Run or Agent, so those correlation fields are empty. Built on a subscribe
model: each write path emits a typed event and the Audit module consumes it;
nothing calls Audit directly. See [ADR-0004](docs/adr/0004-audit-log-design.md).

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
The desktop presentation layer (Electron, ADR-0002) that wraps the UI in a window.
In managed mode it owns a local **Daemon** child. In external mode it connects to
an already-running Daemon through a loopback endpoint and neither starts nor stops
a local Daemon. One Shell instance chooses exactly one mode at launch.

**External Daemon Mode**:
A Shell launch mode driven by a short-lived connection descriptor. The descriptor
provides a loopback endpoint, expiring session credential, expected Daemon
identity, and display label for a Daemon owned outside Hive's Shell. External mode
never falls back to spawning a local Daemon and never assumes how the endpoint was
transported.

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
- A **Deployment Overview** joins desired, deployed, and observed state on the
  Daemon machine; the Shell does not reconstruct that join client-side.
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
external Model-Context-Protocol integration. (In #1 these map onto a Source's
`skill` / `snippet` / plugin-and-bundle Capabilities the user deploys to a CLI.)

### Deferred flagged ambiguities

- **The `agent` Capability kind vs the Hive Agent.** Kept distinct by namespace +
  case: lowercase Source-namespaced `agent` (a deployable CLI subagent Capability,
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
Reference content — a **Source** of Capabilities like any other, and the
`agent-kit` CLI. It is not the capability-format authority (that SSOT is the
`capability-schema` package); what Hive validates against it is the deploy
contract — target locations per kind, the include/sidecar/translation rules, the
Deployment Ledger schema — read from a pinned clone. See AGENTS.md "Reference
projects" for the local path and the exact verified SHA.

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
