# Multi-source capability model

status: accepted; superseded-in-part — the synchronous deploy engine and its
`resolveSelection` plan, the `verify` pass, and the fingerprint sidecar
(Source-winner provenance) are removed; ADR-0029's accepted Deploys, Deployment
State, and Deployment Overview replace them
extends: ADR-0021
supersedes-in-part: ADR-0021 (the single-**Kit** assumption)

## What this ADR records

Hive stops managing a single hardcoded **Kit** (`my-agent-kits`) and instead
manages **N user-added Sources** — git repositories of **Capabilities** that
conform to Hive's capability format (ADR-0024). The user can add a Source by URL,
toggle it on/off, delete it, and the app tracks each one. Deploy scope is
unchanged: still the **local CLI homes** (`~/.claude/`, `~/.codex/`, `~/.agents/`);
containers/remote/harness targets were considered and explicitly ruled out. This is
the "manage everyone's capabilities, compose from many sources, maintain durably via
git" goal made concrete.

Most terms below are **product decisions** parked here, not in `GLOSSARY.md` —
they graduate into the glossary only once they settle.

## The model

**Source as a tracked entity + a Hive-private registry.** A Source is
`{id, origin, active, …}` with `id` a stable opaque identity (not the git URL,
which can change). The set of Sources lives in a Hive-private registry under the
Hive home — **never** in the agent-kit **Deployment Ledger** (the Ledger is the
fixed agent-kit interop schema; cf. the same reasoning that keeps deploy-time
fingerprints out of it, `kit/targets.ts`).

**No default Source.** A fresh install starts with no Sources. The user adds
curated Tiles (ADR-0033) or any Source by its link, so Hive ships no sample kit.

**Per-Source Sync + per-Source Mirror; never physically merged.** Each active
Source syncs independently into its own Mirror. Hive does **not** merge Source
trees on disk (that would lose provenance and create on-disk collisions); the
unified, deduped catalog is **computed in memory** over the set of Mirrors.

**Two identities (the crux of duplicate handling).**

- **CapabilityKey** = `(kind, leaf-name)` — the *deploy identity*. Must be unique
  per kind inside a CLI home (the agent-kit contract flattens to leaf name).
- **ContentSha** = content hash of the Capability — the *content identity* (Hive
  already computes this, `kit/deploy/artifact-hash.ts`).

| Across active Sources | Same ContentSha | Different ContentSha |
|---|---|---|
| Same CapabilityKey | **Merge** → one entry, N Source labels | **Collision** → precedence resolves |
| Different CapabilityKey | (n/a) | Distinct Capabilities |

**Source precedence + Shadowed Capability.** On a different-ContentSha,
same-CapabilityKey collision, the **highest-precedence active Source wins** the
Deploy; the losers are **Shadowed**. A Shadowed loser is realized as a **distinct
non-deployable catalog entry** — its own content Variant (one `CapabilityEntry` per
ContentSha, sharing `(kind, name)` with the winner) carrying `shadowed:true`, NOT a
side list and NOT collapsed onto the winner. It is **visible as its own row**,
clearly badged "not deployed (duplicate)", **non-blocking**. A shadowed entry also
carries **`shadowedBy`** — the winning Variant's top-provider `sourceId` — so the UI
can name the Source that actually deploys ("Hidden — also provided by `<Source>`").
This *replaces* the old hard "within-kind collision is un-deployable / refuse the
Deploy" rule
(`kit/catalog.ts` `withCollisions`, `kit/selection.ts` `resolveSelection` — which no
longer throws on a cross-Source collision; it resolves the winner). A duplicate
CapabilityKey **inside a single Source** is still treated as a malformed-source
problem and marked un-deployable (and is NOT `shadowed`).

The AggregationService ships as a **pure Core module** (`sources/aggregation.ts`),
called from the kit read path; the `KitSvc.catalog()/sync()` → Sources-service
context-split is **consciously deferred**, so this upstream/downstream seam is
half-realized by design (a functional core, not yet a new Effect service Tag).

**Source precedence is a stored `rank`, and the newest Source wins.** Each Source
carries an explicit integer `rank` (higher wins a collision); aggregation reads it
as the **sole** precedence signal (no runtime kind-band, not registration index,
not `createdAt`). Each `add` takes `max(rank)+1`, the new highest, so the newest
Source wins. There is no re-rank
control: precedence matters only for a duplicate Capability, and removing and
re-adding a Source makes it the newest. Persistence is versioned; the `rank` field
was a greenfield discard-and-reseed (no migration).

**Toggle/delete semantics.** Deactivating or deleting a Source deactivates and
hides its Capabilities. A *merged* Capability survives as long as ≥1 active Source
still provides its ContentSha (only its Source-label set shrinks). Removing a
Source from the UI first turns off the selected Capabilities only it provides, so
the next Deploy uninstalls them rather than leaving them installed without a
Source.

**Source-winner provenance.** Which Source won a deployed name is recorded in the
Hive-private fingerprint sidecar (`kit/targets.ts` `fingerprintPath()`), never in
the interop Ledger — preserving the agent-kit ↔ Hive ACL.

## Context relationship (the lines, not the boxes)

A new **Sources** bounded context sits **upstream** of the existing **Deploy**
context (today's `kit` module). Sources owns the registry, per-Source sync, and a
Core **AggregationService** (merge + precedence → a winner per CapabilityKey +
shadow list). It publishes an **AggregatedCatalog + winner-per-key** read model;
the Deploy context is a **downstream customer** that consumes it and stays ignorant
of how many Sources exist or how they merged. That ignorance is the
anti-corruption layer — multi-source complexity never leaks into the deploy
contract. `KitSvc` (`kit/effect/kit-live.ts`) splits along this seam: `catalog()` +
`sync()` move to a Sources service; `diff()`/`deploy()`/`verify()` stay in Deploy
and read the aggregated catalog. The far-edge agent-kit Ledger ACL is untouched.

`resolveSelection` no longer throws on collision; the resolved plan carries the
winning `SourceId` per selected CapabilityKey so the Deploy reads artifacts from the
right Source's Mirror.

## Bundled local Sources

A `local` Source is a kit bundled inside Hive's repository; only the dev fixture
Sources are local. The public add route never adds one; a dev daemon seeds them.

- **Local Sync = copy into a Mirror.** A local Source's Sync copies the bundle into
  a normal Mirror through the same atomic stage→swap, so the catalog and Deploy read
  it like any other Mirror. It re-copies on every run.
- **`"local"` sync-status.** A typed `local` freshness state (no SHA / fetchedAt),
  never a synthetic SHA and never a failed network check.
- **Seed semantics.** Seeded first-run-only in dev fixture mode, so deleting them
  sticks. Seeding is a **system action** off the audited service path, so it emits
  **no** `source.added` audit event.

## Considered alternatives

- **Stay single-Kit** — rejected; kills the community-reuse goal.
- **Physically merge Source trees** — rejected; loses provenance, creates on-disk
  collisions, complicates toggle/delete.
- **Put Source metadata in the Deployment Ledger** — rejected; breaks the
  byte-faithful agent-kit interop schema.
- **Source-qualified deploy names** (`code__my-skills`) — rejected; breaks the flat
  unique-leaf-name contract CLIs discover by.
- **Refuse the Deploy on every cross-Source collision** (explicit per-collision
  pick) — rejected as the default; precedence + visible Shadow badge is
  lower-friction and still transparent. (A per-collision override UI may come
  later.)

## Open (not yet decided)

- (Resolved — **byte-identical**.) "Merge" requires a **byte-identical** ContentSha;
  no normalization now. A CRLF / frontmatter-key-order difference surfaces as a
  Collision (winner + Shadowed), not a Merge — visible, non-blocking, and
  forward-compatible (normalizing later can only merge more, never un-merge).

## Consequences

- `kit/catalog.ts` `withCollisions` and `kit/selection.ts` `resolveSelection`
  collision-refusal are rewritten into per-Source validation + cross-Source
  precedence resolution.
- New Hive-private Source registry persistence; new per-Source Mirror layout
  (`mirrorRoot(sourceId)`); `sync.ts`'s hardcoded `superliaye/my-agent-kits`
  becomes one (bundled or pre-added) Source among many.
- `my-agent-kits` becomes a Source like any other (ADR-0024), pasteable by URL — the
  acceptance test for this feature.
