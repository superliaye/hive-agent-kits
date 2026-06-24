# Multi-source capability model

status: accepted
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

Most terms below are **product decisions** parked here, not in `CONTEXT.md` —
they graduate into the glossary only once they settle. The **Starter Source** has
now **settled** (it ships — see "Starter Source implementation" below), so it is
promoted into `CONTEXT.md` alongside **Source**; the rest stay parked.

## The model

**Source as a tracked entity + a Hive-private registry.** A Source is
`{id, origin, active, …}` with `id` a stable opaque identity (not the git URL,
which can change). The set of Sources lives in a Hive-private registry under the
Hive home — **never** in the agent-kit **Deployment Ledger** (the Ledger is the
fixed agent-kit interop schema; cf. the same reasoning that keeps deploy-time
fingerprints out of it, `kit/targets.ts`).

**Starter Source.** A bundled in-repo workspace package is the **default Source**,
enabled by default, deactivatable to start from scratch. Unlike a user-added
Source it is **local** — no network Sync. ("Maintained in the repo as a package."
ADR-0024 names the package.) It **replaces** the old remote `my-agent-kits`
fresh-install seed: `my-agent-kits` is now just a Source the user may add by URL
like any other. See "Starter Source implementation" below for how it ships.

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
Deploy; the losers are **Shadowed** — visible, clearly badged "not deployed
(duplicate)", **non-blocking**. This *replaces* the old hard "within-kind collision
is un-deployable / refuse the Deploy" rule (`kit/catalog.ts` `withCollisions`,
`kit/selection.ts` `resolveSelection`). A duplicate CapabilityKey **inside a single
Source** is still treated as a malformed-source problem and marked un-deployable.

**Toggle/delete semantics.** Deactivating or deleting a Source deactivates and
hides its Capabilities. A *merged* Capability survives as long as ≥1 active Source
still provides its ContentSha (only its Source-label set shrinks).

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

## Starter Source implementation (#32)

The Starter Source ships as the workspace package
`@hive/agent-kit-starter-template` (ADR-0024). Its realization:

- **`kind` discriminator on Source.** `Source` gains `kind: "git" | "local"`. A
  `git` Source syncs over the network; the `local` Starter is copied from the
  bundle. The public add route stays git-only (`GitHttpsUrl`); a local Source is
  only ever **seeded**, never user-added. The on-disk registry version bumps (the
  Starter is greenfield — an out-of-version registry file is discarded and
  re-seeded, not migrated).
- **Local Sync = copy into a Mirror.** A local Source's Sync recursively copies
  the bundle's `capabilities/` + `presets/` into `<hiveHome>/kit/mirrors/starter/`,
  reusing the existing **atomic stage→swap** so a partial copy can't corrupt the
  Mirror. It produces a **normal Mirror** the catalog/deploy read uniformly — no
  per-reader branching. The only consumer that branches on `kind` is the sync
  dispatch. It writes **no provenance file** (a local Mirror has no SHA), and
  re-copies on every run (that is how a bundled-content update propagates on app
  update).
- **`"local"` sync-status.** A typed `local` freshness state (no SHA / fetchedAt)
  derived from `Source.kind` — never a synthetic SHA, never mis-reported as a
  failed network check. The bundled content is **offline-safe** (instruction +
  skill + agent + one preset only; no plugin/bundle, which would exec an external
  installer).
- **Seed semantics.** Seeded **first-run-only** (the `persist.exists()` gate
  holds, so deleting the Starter sticks). Seeding is a **system action**, not a
  user `add` — it goes through a store-level `seedLocal` verb that is off the
  audited service path, so first-run seeding emits **no** `source.added` audit
  event.

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

- **Default precedence order** when the user hasn't ranked — e.g. user-added Sources
  above the Starter Source, or registration order. Decide before shipping the
  collision path.
- Whether "merge" requires byte-identical ContentSha or tolerates trivial
  normalization (line endings, frontmatter key order).

## Consequences

- `kit/catalog.ts` `withCollisions` and `kit/selection.ts` `resolveSelection`
  collision-refusal are rewritten into per-Source validation + cross-Source
  precedence resolution.
- New Hive-private Source registry persistence; new per-Source Mirror layout
  (`mirrorRoot(sourceId)`); `sync.ts`'s hardcoded `superliaye/my-agent-kits`
  becomes one (bundled or pre-added) Source among many.
- `my-agent-kits` becomes a Source like any other (ADR-0024), pasteable by URL — the
  acceptance test for this feature.
