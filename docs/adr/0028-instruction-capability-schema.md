# Instruction capability schema (per-kind ratification)

status: accepted
relates-to: ADR-0024, ADR-0025, ADR-0026, ADR-0023

## What this ADR records

Ratifies the strict Zod schema for the `instruction` capability kind in
`@hive/capability-schema` (`src/kinds/instruction.ts`, exported as
`InstructionFrontmatter`), wired into the `validate()` gate of
`@hive/capability-schema-tools`. A malformed `*.instructions.md` now fails at
**add/validate-time** with a located `ConformanceError`, not mid-Deploy. Per-kind
continuation of ADR-0024, alongside `skill` (#39), `plugin` (ADR-0025), `bundle`
(ADR-0026), and `agent` (ADR-0027).

## What an instruction is

An `<name>.instructions.md` is a **file-kind** capability
(`instructions/<name>.instructions.md`): one file per capability, its name taken
from the filename. At deploy the frontmatter is **stripped** and the body
**concatenated** into `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`. Only a readable
body matters at deploy — nothing in the frontmatter is load-bearing.

## Required vs optional fields

| Field | Rule | Why |
|---|---|---|
| `description` | required, non-empty | the consistent, demonstrable malformed→fail-at-validate-time floor; every reference instruction has one |
| anything else (`applyTo`, `added_in`, `derived_from`, `synced`, …) | passthrough (preserved) | none is load-bearing at deploy; refining it would over-constrain real content |

There is **no `name` field and no name==dir rule** — instruction is a file kind, so
its name comes from the filename, not the frontmatter.

## Decisions and their trade-offs

- **`description` (min 1) is the only strict floor.** Nothing in the frontmatter is
  load-bearing at deploy, so the schema could in principle gate nothing — but a
  pure-passthrough schema can never report `conformant:false`, making the gate an
  untestable no-op and giving authors no validate-time signal. Requiring
  `description` is consistent with every other kind and yields the demonstrable
  malformed case (#45's whole point), including the most likely real-world
  authoring error: a file with **no `---` frontmatter block at all**, which
  degrades to a located error without throwing.

- **Optional fields stay passthrough.** `derived_from` (a URL) and `synced` (a
  boolean) carry no deploy meaning, so URL/boolean refinement would over-constrain
  real reference content for zero benefit. The lenient superset accepts them as-is.

- **Lenient superset** (ADR-0024 stance): `.passthrough()` so every author-specific
  key rides through. Every `*.instructions.md` in the my-agent-kits clone validates
  `conformant:true` verbatim — an exhaustive regression guard over the whole clone
  lives in the schema-tools `validate.test.ts`.

- **`validate()` stays non-rejecting** (ADR-0023/0024): a malformed instruction
  reports a located `ConformanceError` and the Source is still added with
  `conformant:false`. Absent/unparseable frontmatter degrades to a located error,
  never a throw.

## Out of scope

`mcp` remains the sole ungated kind (deferred — it depends on an external evolving
spec and has no deploy adapter yet). The deploy-side loose parse (`?? ""` defaults)
stays as defense-in-depth — this ADR only adds the earlier validate-time gate;
`parse()` stays lenient, only `validate()` goes strict.
