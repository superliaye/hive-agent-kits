# Agent capability schema (per-kind ratification)

status: accepted
relates-to: ADR-0024, ADR-0025, ADR-0026, ADR-0023

## What this ADR records

Ratifies the strict Zod schema for the `agent` capability kind in
`@hive/capability-schema` (`src/kinds/agent.ts`, exported as `AgentFrontmatter`),
wired into the `validate()` gate of `@hive/capability-schema-tools`. A malformed
`AGENT.md` now fails at **add/validate-time** with a located `ConformanceError`,
not mid-Deploy. Per-kind continuation of ADR-0024 ("the format is ratified one
capability kind at a time, each in its own ADR"), alongside `skill` (#39), `plugin`
(ADR-0025), and `bundle` (ADR-0026).

## What an agent is

An `AGENT.md` is a **folder-kind** capability (`agents/<name>/AGENT.md`),
isomorphic to skill: deploy copies the raw `AGENT.md` into the Claude home (Codex
gets a TOML translation with `model`/`tools` intentionally dropped — a per-CLI
deploy fact, not a schema field). Load-bearing at deploy: `AGENT.md` exists, a
`description` is read (falling back to ""), and the effective `name` falls back to
the directory when omitted. Because that name-falls-back-to-dir behavior is
identical to skill, agent shares the same **folder-kind name contract**.

## Required vs optional fields

| Field | Rule | Why |
|---|---|---|
| `description` | required, non-empty, **NO max cap** | every reference agent has one; real descriptions run 600+ chars |
| `name` | optional / nullish; when present: 1–64 lowercase-alnum-hyphen, no reserved words, no XML chars | a declared name the CLI would reject is a robustness gap; an omitted/blank name defers to the directory |
| `name == parent directory` | enforced in `validate()` only when a string name is declared | frontmatter alone can't know its directory; the daemon's fs adapter supplies it |
| anything else | passthrough (preserved) | lenient superset |

## Decisions and their trade-offs

- **Agent mirrors skill exactly on the name rules.** Both are folder kinds whose
  effective name is the directory, with the same CLI-rejection guards (regex,
  reserved words `anthropic`/`claude`, XML-tag chars) on a PRESENT name and the
  same name==dir cross-file rule. The shared contract — `NAME_PATTERN`,
  `refineName`, and `assertNameMatchesDir(name, dirName, kind)` — lives once in
  `src/kinds/name.ts`, consumed by both kinds, so the regex and guards cannot
  drift. `assertNameMatchesDir` takes a required `kind` label so its message names
  the offending kind.

- **`description` has NO max cap** (unlike skill's 1024). Real my-agent-kits agent
  descriptions exceed 600 chars (the longest is 641), and length is not
  load-bearing at deploy — deploy reads `description` and otherwise copies the file
  through. A cap would reject real reference content, violating the lenient-superset
  regression guard. `min(1)` is the only constraint, giving the demonstrable
  malformed→fail-at-validate-time case.

- **Lenient superset** (ADR-0024 stance): `.passthrough()` so author-specific keys
  (`added_in`) ride through; strict only on the load-bearing fields above. Every
  `AGENT.md` in the my-agent-kits clone validates `conformant:true` verbatim — an
  exhaustive regression guard over the whole clone lives in the schema-tools
  `validate.test.ts`.

- **`validate()` stays non-rejecting** (ADR-0023/0024): a malformed agent reports a
  located `ConformanceError` (including the caught name==dir throw) and the Source
  is still added with `conformant:false`. Absent/unparseable frontmatter degrades
  to a located error, never a throw.

## Out of scope

With `agent` and `instruction` ratified, **all five modeled capability kinds are
now strictly gated by `validate()`** — no kind remains ungated. `mcp` is a deferred
*future* kind: it is not a member of `CapabilityKind`, so the walk never emits it,
and it depends on an external evolving spec and a deploy adapter that do not yet
exist; the dispatch's exhaustiveness check forces gating it on the day it joins the
enum. The deploy-side loose parse (`?? ""` defaults) stays as defense-in-depth —
this ADR only adds the earlier validate-time gate; `parse()` stays lenient, only
`validate()` goes strict.
