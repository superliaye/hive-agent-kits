# Capability format as an SSOT package set

status: accepted
relates-to: ADR-0023

## What this ADR records

Hive extracts **the capability format** — the contract a **Source** repo conforms
to — out of the daemon (and out of `my-agent-kits/lib`) into dedicated packages
that become the single source of truth. This is what makes "paste any conformant
git repo" possible and is the moat the format-research identified: the agent
ecosystem converged on the *atom* formats (Agent Skills `SKILL.md`, `AGENTS.md`,
MCP `server.json`) but **not** on a deploy-manager over them.

## The three packages

```
capability-schema            zod only · types + Zod schemas + format-version   ← SSOT (spec in code)
   ▲          ▲
   │     capability-schema-tools   parse(tree)/validate(tree)/lint + SourceTree port + thin CLI
   │          ▲                    (depends on capability-schema; fs only in the CLI)
@hive/contract                 wire envelopes (Selection, DeployDiff, HTTP DTOs)
   ▲                            ← depends on capability-schema for the capability vocabulary
@hive/daemon                   fs SourceTree adapter + deploy context (transforms/exec/Ledger)
agent-kit-starter-template     content only · the Starter Source · devDep on -tools for CI self-validation
```

1. **`capability-schema`** — pure types + Zod schemas + the format-version and the
   identity value objects (`CapabilityKind`, `CapabilityKey`, `ContentSha`). `zod`
   is its only dependency. The publishable spec-in-code.
2. **`capability-schema-tools`** (name TBD) — `parse`/`validate`/`lint` over a
   `SourceTree` read-port, plus a thin validator CLI. Depends on `capability-schema`.
3. **`agent-kit-starter-template`** — content only (the Starter Source of ADR-0023);
   devDepends on `-tools` to self-validate in CI.

## Boundaries (junk-drawer discipline)

- **In the packages:** read + validate + types. **Pure** — no `fs`/HTTP/`exec`/Effect
  in the core; the daemon provides the fs-backed `SourceTree` adapter, the CLI is
  the one fs-coupled spot.
- **Stays in the daemon (Deploy context):** writing into CLI homes, the
  kind→home mapping, render transforms (`SKILL.md` → claude/codex), include/snippet
  *rendering*, the agent-kit Ledger. The package answers "what is this repo?"; the
  daemon answers "how do I deploy it." (Snippet *resolution rules* — valid-include,
  cycle detection — may live in the package; rendering stays in the daemon.)
- **`@hive/contract` depends on `capability-schema`**, not the reverse: the schema
  owns the capability *vocabulary* (SSOT), `@hive/contract` keeps only the *wire
  envelopes* around it. The format package is the anti-corruption layer over
  external Source repos.

## Phased, per-kind ratification — skills first

The format is ratified **one capability kind at a time**, each in its own ADR.
First: **skills adopt `SKILL.md`, the Agent Skills open standard**
([agentskills.io/specification](https://agentskills.io/specification)) — the golden
standard, referenced rather than reinvented, with a validator. Future ADRs cover
`instruction` (AGENTS.md), `agent` (subagent — no cross-tool standard exists, so
per-CLI translation stays), `mcp` (`server.json`, pin spec **2025-11-25**, not the
RC), `plugin`, and `bundle`.

## Format authority moves out of my-agent-kits

`my-agent-kits` is today both *content* and the `lib/deploy.js` contract authority
Hive reproduces (AGENTS.md "Reference projects"). After this ADR the **format SSOT
is `capability-schema(-tools)`**, and `my-agent-kits` demotes to **reference content
/ a Source** — migrated to conform, then pasted by URL as the first external
consumer. Update AGENTS.md's framing accordingly. The deploy *contract* (how bytes
land in homes) is still validated against the pinned clone.

## Naming

Build under the internal `@hive/*` scope now, but **do not bake "hive" into the
type names** — design `capability-schema` to graduate to a neutral published name
(e.g. `agent-capability-schema`) once v1 of the format locks, so community authors
can adopt it as a standard rather than a Hive-internal type.

## Considered alternatives

- **Full standards alignment in one shot** — rejected; ratify per-kind so each
  schema gets real scrutiny.
- **A single combined format/tools package** — rejected; the UI/contract want
  zero-dep *types*, the daemon/CI want *behavior*. The split keeps the publishable
  SSOT dependency-minimal.
- **Leave the format in the daemon / in `my-agent-kits/lib`** — rejected; it can't
  then be validated by community authors, a starter's CI, or a standalone CLI, which
  defeats the pivot.

## Sequencing (with ADR-0023)

1. Extract `capability-schema` from `kit/catalog.ts`'s pure core + ratify the
   **skills** schema.
2. Validate *current* `my-agent-kits` against it (it should mostly conform — the
   format is extracted from it); gaps = the migration checklist.
3. Ship the multi-source consume path (ADR-0023).
4. Migrate `my-agent-kits` to fully conform; paste its URL as the first external
   Source — the acceptance test.
