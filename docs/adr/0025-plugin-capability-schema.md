# Plugin capability schema (per-kind ratification)

status: accepted
relates-to: ADR-0024, ADR-0023

## What this ADR records

Ratifies the strict Zod schema for the `plugin` capability kind in
`@hive/capability-schema` (`src/kinds/plugin.ts`, exported as `PluginFrontmatter`),
wired into the `validate()` gate of `@hive/capability-schema-tools`. A malformed
`.plugin.md` now fails at **add/validate-time** with a located `ConformanceError`,
not mid-Deploy. This is the documented per-kind continuation of ADR-0024 ("the format
is ratified one capability kind at a time, each in its own ADR"); skills were phase 1
(#39), plugin is this slice (#45) alongside `bundle` (ADR-0026).

## What a plugin is

A `.plugin.md` is a **marketplace pointer**, not bytes to copy. Deploy reads
`marketplace_source` and passes it verbatim to `claude plugin marketplace add`, then
installs `marketplace_name` from that marketplace. Plugins are **Claude-only** at
deploy — but that is a deploy fact, recorded here, not a schema field: the frontmatter
carries no target.

## Required vs optional fields

| Field | Rule | Why |
|---|---|---|
| `description` | required, non-empty | consistent with skills; every reference file has one |
| `marketplace_source` | required, non-empty string | load-bearing: deploy forwards it to `claude plugin marketplace add` |
| `marketplace_name` | required, non-empty string | load-bearing: the marketplace entry deploy installs |
| `plugin_name` | optional, non-empty when present | deploy defaults it to the `.plugin.md` filename leaf |
| anything else | passthrough (preserved) | lenient superset |

## Decisions and their trade-offs

- **`marketplace_source` is a non-empty string with NO org/repo/URL regex.** Deploy
  passes the value through unchanged, and the reference content already mixes forms
  (`anthropics/claude-plugins-official`, third-party `owner/repo`). A regex would
  reject valid Sources for zero benefit — the runtime, not Hive, decides what a
  marketplace pointer may be. Non-empty is the only load-bearing constraint.
- **`plugin_name` is optional** because deploy already defaults it to the filename
  leaf. Requiring it would diverge from the live deploy default and reject the
  minimal valid plugin.
- **Lenient superset** (ADR-0024 stance): `.passthrough()` so author-specific keys
  (`applyTo`, `added_in`) don't make a plugin non-conformant; strict only on the
  three load-bearing coordinates above. The three my-agent-kits reference plugins
  validate `conformant:true` verbatim — that regression guard lives in
  `validate.test.ts`, not `deploy.test.ts` (which never calls `validate()`).
- **`validate()` stays non-rejecting** (ADR-0023/0024): a malformed plugin reports a
  located `ConformanceError` and the Source is still added with `conformant:false`.
  Absent/unparseable frontmatter degrades to a located error, never a throw.

## Out of scope

`agent` and `instruction` remain ungated (no strict schema yet). The deploy-side
loose parse (`sources.ts` `?? ""` defaults) stays as defense-in-depth — this ADR only
adds the earlier validate-time gate.
