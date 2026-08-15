# Arca remote capability control

Status: approved architecture, pending written-spec review

Date: 2026-08-14

## Outcome

Hive's Mac desktop becomes a reliable control surface for Capabilities that are
materialized and deployed on Arca. A normal Hive launch continues to manage a
local Daemon. A `hive-arca` launch connects the same Shell to one Daemon on Arca;
that Shell instance starts no Mac Daemon and owns no deployment state.

The daily flow is:

1. Run `hive-arca` on the Mac.
2. See Sources from `my-agent-kits` and a personal Universe capability-kit root.
3. See each supported Capability's desired, deployed, and verified state on Arca.
4. Toggle Capabilities on or off. The durable Selection changes immediately on
   Arca, but the CLI homes do not until an explicit Deploy.
5. Review the Deploy Diff and explicitly Deploy.
6. Close and reconnect without losing Source, Selection, provenance, failure, or
   on-disk state.

The Day-0 milestone is complete only after automated validation, an Arca-local
exercise, and a one-command Mac smoke test.

## Scope

Day 0 includes:

- a generic Shell external-Daemon mode;
- Source Locators for git revision/subpath and Daemon-host working-tree snapshots;
- capability-kit roots using the existing `capabilities/` and `presets/` format;
- a Daemon-owned durable Selection and one authoritative Deployment Overview;
- stale-plan protection and durable deploy provenance/failures;
- an Arca adapter outside Hive; and
- a new personal Universe capability-kit root.

Day 0 does not include plugin-root ingestion, independent toggles for skills
inside a plugin, MCP deployment, `my-devloop` integration, or automatic Deploy.
Existing `plugin` Capabilities remain whole-plugin marketplace pointers. These
constraints preserve relative plugin dependencies and keep the first delivery on
Hive's already-ratified capability format.

Day 0 is the remote-control foundation: it supports `my-agent-kits` and conformant
Universe capability-kit roots. It does not yet ingest existing plugin roots such
as Appa or `my-devloop`. On/off deployment is effective for instruction, skill,
and `agent` Capabilities written into CLI homes. Plugin and bundle deselection is
advisory: Hive does not disable or uninstall them, so their child skills may
remain exposed. Whole-plugin discovery and enable/disable is the next acceptance
milestone; independent plugin-component selection remains later work.

## Runtime topology

```text
Mac                                                  Arca

~/.local/bin/hive-arca
  ├─ ensures remote Daemon ------------------------> Hive Daemon
  ├─ arca et 127.0.0.1:33117 ---------------------> 127.0.0.1:3117
  ├─ writes short-lived 0600 connection file         ├─ ~/.hive/
  └─ launches Hive Shell in external mode             ├─ Sources + Mirrors
       └─ Hive UI ───── HTTP over the forward ────────├─ Selection + Deployment State
                                                     ├─ Deployment Ledger
                                                     └─ Arca CLI homes
```

There is one active Daemon for an external Shell launch: the Arca Daemon. The
packaged Mac app may still contain a Daemon binary, but external mode does not
probe, spawn, signal, or stop it. Managed and external mode are a discriminated
launch choice, not runtime fallback states. A separately launched local Hive
instance may coexist, but it uses a different port and state authority.

The Arca Daemon and Eternal Terminal forward remain bound to loopback. The Mac
uses a dedicated non-default port, so external mode cannot attach to or stop a
local Hive Daemon on the default port. A live interactive `arca et` session may
already own the dedicated forward; the launcher reuses it without assuming
ownership and creates a supervised session only when no forward exists.

Arca is the Daemon host, not a new Deploy target. From the Deploy context's point
of view, Arca's CLI homes are local filesystem targets exactly as required by
ADR-0023; only the Shell-to-Daemon control connection crosses machines.

## Artifact ownership

| Location | New or changed artifacts | Responsibility |
|---|---|---|
| `hive-agent-kits` | Shell connection mode, connection descriptor contract, Source Locator transports, durable Selection, Deployment State/Overview, UI | Generic product behavior; contains no Arca command, hostname, or lifecycle assumption |
| `universe/experimental/leon-ye_data/hive-arca/` | Mac launcher, remote lifecycle helper, installer, tests, README | Arca CLI integration, Daemon bootstrap, tunnel supervision, and Hive app launch |
| `universe/experimental/leon-ye_data/agent-kits/` | `capabilities/`, `presets/`, authoring docs | Databricks/repository-specific Capabilities in Hive's normal kit format |
| `my-agent-kits` | No topology-specific changes | Repo-agnostic Capabilities, maintained and released as today |
| Mac installed state | `/Applications/Hive.app`, `~/.local/share/hive-arca/`, `~/.local/bin/hive-arca`, one temporary connection directory per launch | UI, launcher, and ephemeral transport only |
| Arca runtime state | `~/.hive/`, `~/.agent-kit/manifest.json`, `~/.claude/`, `~/.codex/`, `~/.agents/` | All Source, desired, deployed, audit, and actual CLI-home authority |

Canonical adapter source lives in Universe. A one-time bootstrap installs a
versioned copy under `~/.local/share/hive-arca/<version>/` and updates
`~/.local/bin/hive-arca`. The bootstrap may copy from an explicitly supplied Mac
checkout or fetch the payload through `arca et`. It may symlink
only when the canonical source itself exists on the Mac; no Mac Universe checkout
is assumed. Installed files are not a second source of truth.

## Generic external-Daemon seam

The Shell resolves one launch configuration:

```ts
type ShellConnection =
  | { kind: "managed" }
  | { kind: "external"; descriptorPath: string };

type ExternalConnectionDescriptor = {
  version: 1;
  baseUrl: string;
  displayName: string;
  expected: {
    protocolRange: string;
    daemonInstanceId: string;
    runtimeRootId: string;
    buildVersion: string;
  };
  session: {
    sessionId: string;
    sessionToken: string;
    expiresAt: number;
  };
};
```

Production external descriptors accept only loopback HTTP endpoints. The Shell
validates the file with Zod, verifies owner-only permissions, reads it once, and
removes it. Only the descriptor path appears in process arguments. The session
credential is never placed in a URL, process argument, persistent setting, or
log. The descriptor carries an expiring external session credential, never the
Daemon's durable `~/.hive/.token`. The remote helper authenticates on Arca
loopback with that durable token and mints the session tuple; sessions expire
automatically, and `hive-arca` revokes its session on exit best-effort. The
durable credential never leaves Arca.

Daemon session-mint and revoke endpoints require the durable credential; an
external session cannot mint another session. Session records are memory-only,
store only a token hash, and have a fixed maximum lifetime long enough for one
working day. A Daemon restart or expiry invalidates them. A launcher crash may
skip revocation, but cannot create a durable Mac credential.

Electron main retains the active credential and releases it only to the expected
preload frame through sender-bound IPC. Neither the token nor an object containing
it is exposed in the renderer main world. Preload exposes authenticated request
and subscription functions plus non-secret display metadata, attaching
Authorization inside the isolated context and accepting only relative Daemon API
paths. The same seam replaces the current local token argument so managed and
external production modes do not diverge.

`/api/ready` returns protocol version, build version, Daemon instance id, an opaque
runtime-root id, and deploy-target mode. Descriptor `version` governs only the
descriptor shape. Before opening the window, external mode requires a compatible
protocol, the exact expected instance and runtime-root identities, the expected
build, and `deployTargetMode: "real"`. Failure is terminal and actionable; it
never falls back to a managed Daemon.

`hive-arca` starts a fresh app instance through the app executable or
`open -n -W`, records that process, and ties tunnel cleanup to its exit. External
mode bypasses both the close-during-Deploy confirmation and Daemon drain/kill
paths: an accepted remote Deploy survives Shell exit. The resolved connection
remains in Electron main memory for macOS window reactivation. Managed mode keeps
its close guard, but reads Daemon-reported active-operation state rather than the
lifetime of the now-short HTTP mutation.

The UI receives `displayName` and connection status. A tunnel interruption shows
a disconnected state and retries reads with bounded backoff. Reconnection reloads
the Deployment Overview from Arca instead of trusting stale client state.

## Source Locators and Mirrors

The Source registry replaces the overloaded `kind`/`origin` pair with an explicit
locator:

```ts
type SourceLocator =
  | { kind: "starter" }
  | {
      kind: "git";
      repoUrl: string;
      revision:
        | { mode: "track"; ref: string }
        | { mode: "pin"; commit: string };
      subpath: string;
    }
  | {
      kind: "working-tree";
      repoRoot: string;
      subpath: string;
    };
```

A Source also retains its stable id, label, active flag, rank, and creation time.
The registry gains a revision and migrates current git Sources to
`revision: { mode: "track", ref: "refs/heads/main" }`, `subpath: "."`,
preserving today's hard-coded branch; the Starter becomes a `starter` locator.
Track mode accepts fully qualified branch or tag refs; pin mode requires a full
commit id. Stored URLs remain credential-free HTTPS URLs.

Duplicate identity is the normalized full locator: repository URL, revision, and
subpath for git; canonical repository root and subpath for working trees. Sources
may share a repository URL. The shared Git object cache is separate infrastructure
and is garbage-collected only after no Source references it.

All acquisition runs on the Daemon machine behind a narrow Git process port that
is separate from deploy-installer execution. It preserves the Daemon `HOME` and
ambient credential helpers while adding `GIT_TERMINAL_PROMPT=0`; it never uses the
deploy adapter's redirected child environment. It invokes `git` directly without
a shell, resolves the requested revision to an exact commit, and materializes only
the selected subpath. A Hive-created bare cache performs bounded partial fetches
and safe subtree export without checkout hooks, submodules, LFS smudging, or
user-defined clean/smudge filters. It never silently falls back to cloning the
full Universe history: an unsupported partial fetch or exceeded time/size budget
fails visibly. Fetches serialize per repository. Provenance records repository
URL, requested revision, resolved commit, subpath, tree identity, and capture
time.

A working-tree Source requires a canonical Git top-level owned by the Daemon uid
and contained in a generic configured allowlist. The Arca adapter may configure a
Universe root through this generic seam; Hive contains no Arca path. Sync includes
subpath-scoped tracked files and non-ignored untracked files, records HEAD and
dirty state, and computes a byte identity. It captures HEAD/status before and
after staging; a concurrent change retries or fails `working_tree_changed`. Both
transports enforce file-count and byte limits and reject traversal, leading-dash
refs, unsafe protocols, and links escaping the allowed root before atomically
swapping into the per-Source Mirror. Deploy never reads the live checkout, and a
failed Sync retains the last good Mirror.

The selected subpath becomes the Mirror root. In particular,
`<checkout>/<subpath>/capabilities` materializes as `<mirror>/capabilities`, and
its sibling `presets/` materializes as `<mirror>/presets`; repository ancestors
and the subpath directory name are not retained. An existing subpath without
`capabilities/` remains registered under Hive's non-rejecting conformance policy
but is reported explicitly as an empty, non-capability-kit Source rather than a
successfully usable kit. Materialization preserves file bytes, executable modes,
and internal symlinks while rejecting links that escape the selected tree.

Initial Sources are expressible without Hive knowing about Arca:

```ts
{
  kind: "git",
  repoUrl: "https://github.com/superliaye/my-agent-kits",
  revision: { mode: "track", ref: "refs/heads/main" },
  subpath: "."
}
```

```ts
{
  kind: "git",
  repoUrl: "https://github.com/databricks-eng/universe",
  revision: { mode: "track", ref: "refs/heads/master" },
  subpath: "experimental/leon-ye_data/agent-kits"
}
```

During authoring, the second Source may instead use `repoRoot: "/home/leon.ye/universe"`
with the same subpath. Git failures use observable stable codes:
`auth_or_repository_unavailable`, `offline`, `missing_ref` only after repository
access succeeds, `invalid_subpath`, `timeout`, and `io`. UI and persisted state
receive bounded redacted detail; raw stderr is redacted in Trace and never
returned to the Shell. The UI describes a working-tree path as a path on the
Daemon machine, never as a Mac path.

Day 0 creates that `agent-kits/` root with `capabilities/`, `presets/`, concise
authoring documentation, and one harmless smoke-test skill. It does not move or
copy Appa or `my-devloop` content. Those roots retain disjoint ownership; a later
plugin integration must preserve plugin-relative and cross-skill dependencies.

## Durable desired and deployed state

Four stores retain distinct authority on Arca:

| Question | Authority |
|---|---|
| What is available? | Source registry plus each Source's last-good Mirror |
| What should be enabled? | Durable Selection with monotonically increasing revision |
| Which names are Hive/agent-kit-owned? | Exact, unchanged Deployment Ledger |
| What content landed, from where, and what failed? | Hive-private Deployment State |

The Selection stores CapabilityKeys and target CLIs, not Preset provenance or
ContentSha. A selected Capability therefore survives Source updates, precedence
changes, deactivation, and temporary unavailability. Applying a Preset is a bulk
Selection mutation. Each mutation supplies `expectedRevision`; a concurrent
editor receives `409 selection_conflict` and reloads before retrying. Selection
persistence carries an initialized schema version. Only an absent, uninitialized
store seeds from the Deployment Ledger; an initialized empty Selection stays
empty, and current-version corruption fails visibly rather than reseeding.

`Selection.targets` is the exact desired target set for each applicable selected
CapabilityKey. Removing a target plans per-target removal for Hive-removable
kinds; Deployment State supplies target attribution that the interoperable Ledger
cannot. Overview exposes `applicableTargets`, and non-applicable pairs such as a
plugin on Codex are never planned.

Source deactivation and deletion never mutate Selection. An unavailable,
Ledger-owned key remains selected and appears orphaned. Toggling an unavailable
owned key off atomically removes it from the enabled set and adds a target-scoped
removal intent. Re-enabling it cancels the intent. The intent survives restart,
Source restoration, and failed Deploys; Deploy clears only targets actually
removed. An absent key without such an intent never authorizes deletion.

A selected unavailable skill or `agent` capability is left untouched. Because
instructions share one whole-file target, an instruction Deploy must reproduce
every desired contribution or leave that target's instruction file untouched. A
selected unavailable instruction therefore blocks instruction-kind reconciliation
for that target until its Source returns or the user records explicit removal; it
is never silently omitted. Other kinds may still proceed best-effort. Plugin and
bundle artifacts left after deselection require manual removal and are never
reported as if Deploy could remove them.

Deployment State evolves the current fingerprint sidecar into per-key,
per-target records that separate `applied` from `lastAttempt`. `applied` records
the most recent successful winning Source, ContentSha, rendered hash, time, and
operation id. `lastAttempt` records action, outcome, time, operation id, and a
bounded semantic error. A failure never overwrites prior successful provenance;
a successful removal clears `applied`. Persisted error detail is redacted and
size-bounded, while full diagnostics remain in Trace. The Ledger schema stays
byte-compatible with agent-kit and contains none of this metadata.

## Authoritative Deployment Overview

`GET /api/kit/overview` replaces the UI's client-side join of Sources, catalog,
Selection, Ledger, Deploy Diff, fingerprints, and verification. Rows are formed
from the union of catalog CapabilityKeys, selected keys, explicit removal intents,
Ledger keys, and Deployment State keys. Selected-but-never-deployed unavailable
keys and Ledger-only keys therefore remain visible. A Ledger-only key without
Hive Deployment State is `unmanaged_owned` and is never removed implicitly. One
Daemon-side snapshot also returns Sources, the Selection revision, catalog
Variants, per-target observations, the current Deploy Diff, active/last Deploy
operation, and an opaque `planToken`.

Each row exposes orthogonal state rather than one overloaded badge:

- catalog: `deployable | shadowed | blocked | unavailable`;
- desired: `on | off`;
- reconciliation: `in_sync | pending_add | pending_update | pending_remove |
  waiting_for_source | orphaned | unmanaged_owned | manual_removal_required`;
- last attempt: `none | succeeded | failed`, with operation id and a bounded
  semantic error when failed; and
- per-target observation: `verified | present_unverified | missing | drifted |
  recorded_unverified | verification_error`.

`pending_update` is target-specific and uses the same would-deploy render-and-hash
computation as Deploy Diff. Copied/verifiable kinds compare current rendered
output with the last successfully applied rendered hash, so shared-snippet and
Hive transform changes are visible. ContentSha remains provenance and the
fallback signal for installer-owned kinds. `present_unverified` is distinct from
verified content, and a read error is not collapsed into missing. Shadowed
Variants remain visible and non-toggleable; the winning CapabilityKey is the
toggle unit.

The plan token commits to a canonical resolved Deploy Plan: Selection revision,
Source registry revision, active Mirror identities and precedence, per-target
actions, would-deploy rendered hashes, Ledger and Deployment State revisions, and
the existence/hash observations of artifacts the plan will overwrite or remove.
Deploy accepts only `{ selectionRevision, planToken }`. It revalidates the token
while holding the Daemon's deployment coordinator immediately before accepting
the operation. A material change returns `409 plan_stale`; the UI refreshes and
requires another explicit Deploy rather than silently applying the new plan.

Deploy and Source/Mirror mutations serialize where their snapshots could race.
While holding that coordinator, the Daemon persists an immutable accepted plan
and operation record, then `POST /api/kit/deploy` returns `202 { operationId }`.
Execution belongs to the persisted operation rather than the request or socket,
so loss of the tunnel cannot cancel it. Overview exposes
`queued | running | completed | failed | interrupted` operation state. On startup,
an operation left running by a Daemon crash becomes `interrupted`, after which a
normal idempotent Deploy may resume reconciliation. A second Deploy while one is
active returns `409 deploy_in_progress`. Selection edits after acceptance affect
only the next plan; Overview immediately shows their pending Diff.

A successful Selection mutation emits one refs-only audit event containing its
revision, per-kind added/removed counts, and targets. Persisting an accepted plan
emits the one Deploy audit event for that user action. Operation progress and
diagnostics belong in Deployment State and Trace, not duplicate audit rows.

## `hive-arca` adapter

`hive-arca` is one Mac command and the only component that knows the Arca CLI and
process lifecycle. It:

1. validates Mac prerequisites and the dedicated loopback port;
2. invokes its remote helper through `arca et -c` with an explicitly configured
   Arca `HOME` to ensure the installed Hive Daemon runs against Arca's real CLI
   homes even when Eternal Terminal inherits the Mac `HOME`;
3. authenticates locally on Arca and mints an expiring external session;
4. reuses an existing `arca et` local forward or starts a supervised Eternal
   Terminal session using the installer's `Host arca*` forward;
5. writes a per-launch owner-only connection descriptor;
6. launches a new Hive Shell instance in external mode and waits for it; and
7. supervises/restarts the tunnel while the app is open, then removes temporary
   Mac files and the tunnel and revokes the session on exit.

Session JSON is streamed from the remote command directly into the owner-only descriptor; token
bytes are never stored in a shell argument or environment variable. Cleanup traps
cover bootstrap, tunnel, app-launch, signal, and normal-exit paths.

The Mac Shell build identifies its supported Daemon protocol and an immutable
Daemon artifact version and digest. Explicit install selects the matching Linux
artifact for Arca's `uname -m`, verifies its digest, and never copies the
host-specific Mac Daemon or builds from an unpinned branch. Universe adapter tests
pin Hive's published descriptor schema and readiness contract.

Arca runs the artifact through an enabled, adapter-owned `systemd --user` unit
with an explicit real-home deployment profile. Ensure and upgrade operations
serialize through that unit; reuse and termination require both the unit identity
and exact Daemon instance identity, never port ownership alone. Concurrent
launchers converge on the same unit. The explicit install step enables and
verifies user lingering so the unit outlives the SSH session; if that prerequisite
cannot be established, installation stops rather than claiming the Daemon will
persist.

The Daemon remains running when the Mac app exits and is re-used on the next
launch. Arca stop/restart may end it; the next `hive-arca` invocation restores it.
The launcher never stops an unrelated process and verifies compatibility before
reuse. Install and upgrade are explicit subcommands; the daily launch never pulls
a repository or silently replaces the Daemon. Configuration may persist the
transport, remote Hive installation, ports, and Mac app location, but never the
durable or session credential.

## Failure behavior

- Invalid or incompatible external descriptor: stop before opening the UI; do not
  spawn a local Daemon.
- Arca CLI authentication or bootstrap failure: `hive-arca` exits with the failed
  stage and remediation, without leaving a descriptor or tunnel.
- Tunnel loss: keep the Arca Daemon and any accepted Deploy alive; show
  disconnected on Mac, retry the tunnel, then reload Overview.
- Session expiry: reject authenticated calls without falling back to the durable
  token; the Shell asks the user to relaunch `hive-arca` for a fresh session.
- Source `auth_or_repository_unavailable`, offline, timeout, budget, or
  `working_tree_changed` failure: keep the last good Mirror and surface the stable
  freshness code; never report it as current.
- Invalid or non-conformant Source content: retain and report the Source under
  Hive's existing non-rejecting conformance rules; block only affected content.
- Stale plan or Selection conflict: return 409 with no deployment write.
- Partial Deploy: update Ledger and Deployment State only for actual outcomes,
  persist failures, and make re-Deploy idempotent.
- Verification read error: surface `verification_error`; do not claim missing or
  verified.

## Validation

Hive automated coverage must include:

- managed/external Shell mode exclusivity, including proof that external mode
  never spawns or kills a local Daemon;
- connection-descriptor validation, permission checks, cleanup, protocol mismatch,
  exact instance checks, session expiry/revocation, and proof that neither durable
  nor session token bytes enter renderer state, argv, URLs, settings, or logs;
- Source registry migration, full-locator uniqueness, and locator boundary
  validation;
- bounded partial git ref/subpath acquisition from temporary repositories using
  the dedicated process adapter, plus working-tree allowlist, dirty/untracked,
  concurrent-change, size-budget, and traversal coverage;
- atomic last-good Mirror retention across acquisition failures;
- Selection restart persistence, revision conflicts, Preset seeding, and explicit
  target-scoped orphan removal;
- unavailable whole-file instruction blocking, exact target removal, target
  applicability, and manual-removal states for plugins/bundles;
- the complete Overview state matrix, including updates, drift, missing,
  unverified, last-attempt failures, shadows, selected-unavailable, Ledger-only,
  and manual-removal rows;
- stale-plan rejection, persisted accepted operations, serialized Deploy,
  request-disconnect continuation, crash interruption, and reconnect
  reconstruction; and
- existing full typecheck, tests, lint, ship, and deploy-contract regression.

Universe coverage must exercise `hive-arca` against fake Arca CLI, SSH fallback,
and app commands, cleanup
on every failure stage, tunnel restart, session revocation, no-secret output,
immutable artifact/digest selection, fresh-app waiting, and idempotent concurrent
remote ensure. Before asking for Mac input, run the Hive suites and an Arca-local
end-to-end flow with redirected CLI homes. The final human gate is:

1. run `hive-arca` on the Mac;
2. confirm only the Arca Daemon is used by that Shell;
3. add/sync both initial Sources;
4. toggle the harmless smoke-test skill and review its Deploy Diff;
5. confirm and Deploy that one new skill into the real Arca CLI home, after the
   already-completed redirected-home validation;
6. verify its Overview and on-disk state from Mac; and
7. close, reconnect, and verify state survives.
