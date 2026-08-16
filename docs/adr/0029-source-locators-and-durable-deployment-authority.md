# Source locators and durable deployment authority

status: accepted
extends: ADR-0023

## What this ADR records

Hive resolves Sources on the Daemon machine and makes the Daemon authoritative
for desired, deployed, and observed capability state. This replaces the earlier
single remote-tree assumption and the Shell's client-side reconstruction of a
Deploy.

## Source Locators and Mirrors

A Source has one explicit locator:

- `starter` copies the bundled Starter Source;
- `git` names a credential-free HTTPS repository, a tracked ref or pinned full
  commit, and a subpath; or
- `working-tree` names an allowlisted absolute Git root on the Daemon machine and
  a subpath.

The locator, not legacy display fields, selects acquisition. Git uses the
Daemon's ambient credentials through a bounded, non-interactive Git process port.
Working-tree acquisition snapshots tracked and non-ignored files and rejects a
tree that changes during capture. Both transports enforce traversal, link,
file-count, byte, and deadline limits.

Acquisition materializes only the selected subtree into a Source-private Mirror.
The new tree replaces the previous Mirror atomically, so a failed Sync leaves the
last-good bytes and provenance available. Deploy reads Mirrors only; it never
reads a live working tree or asks the Shell to acquire Source content.

## Separate durable authorities

Four stores answer different questions:

| Question | Authority |
|---|---|
| What is available? | Source registry and last-good Mirrors |
| What should be enabled? | Revisioned Selection |
| Which names are Hive/agent-kit-owned? | Interoperable Deployment Ledger |
| What landed, from where, and what failed? | Hive-private Deployment State |

Selection stores CapabilityKeys and exact target sets, not Source or ContentSha.
It therefore survives Source refreshes, precedence changes, deactivation, and
temporary unavailability. Mutations use an expected revision; conflicts return
without changing desired state. The Deployment Ledger may seed an absent
Selection once, but never becomes desired-state authority afterward.

Deployment State records successful per-target provenance separately from the
last attempt. A failure cannot erase a prior successful fact. The shared Ledger
schema remains byte-compatible with `agent-kit`; Hive-private provenance and
failure detail do not leak into it.

## Authoritative Overview and accepted Deploys

The Daemon produces one Deployment Overview from a coherent snapshot of Sources,
Mirrors, Selection, Deployment State, the Ledger, and on-disk observations. The
Shell renders this projection and does not reproduce its joins or plan logic.

The Overview carries an opaque token over the canonical resolved Deploy Plan,
including revisions, Mirror identities, actions, rendered hashes, and the
artifacts that would be overwritten or removed. Deploy accepts the reviewed
Selection revision and plan token only. A material change returns `plan_stale`
before any deployment write.

Accepted Deploys are persisted operations. Filesystem application, Ledger merge,
Deployment State updates, audit emission, and recovery are serialized through the
deployment coordinator and ownership-checked advisory locks. The HTTP request and
Shell connection do not own execution. A restart resumes a recoverable operation
or records an interruption; another Deploy cannot run concurrently.

## Consequences

- Source credentials, working-tree paths, and Source bytes remain on the Daemon
  machine.
- Closing or disconnecting a Shell cannot cancel an accepted Deploy.
- Selected unavailable content stays visible instead of being silently dropped.
- Whole-file instruction deployment waits when any desired contribution is
  unavailable.
- Plugin and bundle removal remains advisory because their external installers do
  not provide a safe ownership-preserving uninstall contract.
- The additional persistence and locking complexity is concentrated at the
  Source, Selection, and Deploy seams where crash consistency is required.

## Out of scope

Automatic Deploy, plugin-root ingestion, per-plugin child toggles, and MCP
deployment remain separate product decisions.
