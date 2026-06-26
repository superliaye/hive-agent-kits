# Bundle capability schema (per-kind ratification)

status: accepted
relates-to: ADR-0024, ADR-0025, ADR-0023

## What this ADR records

Ratifies the strict Zod schema for the `bundle` capability kind in
`@hive/capability-schema` (`src/kinds/bundle.ts`, exported as `BundleFrontmatter`),
wired into the `validate()` gate of `@hive/capability-schema-tools`. A malformed
`.bundle.md` now fails at **add/validate-time** with a located `ConformanceError`,
not mid-Deploy. Per-kind continuation of ADR-0024, alongside `plugin` (ADR-0025).

## What a bundle is

A `.bundle.md` wraps an **upstream installer** that lands a toolkit into the CLI
homes via one of two installer kinds, discriminated on `installer.kind`:

- **`setup-script`** — clone `source` at `pinned_commit`, run `installer.command`
  (e.g. gstack runs `./setup`).
- **`npx-skills`** — invoke `npx skills add installer.package` (e.g. hyperframes).

## Required vs optional fields

| Field | setup-script | npx-skills | Why |
|---|---|---|---|
| `description` | required | required | consistent with skills/plugin |
| `source` (top-level) | required, non-empty | optional | the repo the setup script is cloned from |
| `pinned_commit` (top-level) | **required**, non-empty | optional | reproducibility (see below) |
| `installer.command` | required, non-empty | n/a | the script deploy runs |
| `installer.package` | n/a | required, non-empty | the npm/skills spec deploy installs |
| `installer.flags` / `host_flag_map` / `requires` / `verify_paths` / `scope` / `license` | optional / passthrough | optional / passthrough | lenient superset |

## Decisions and their trade-offs

- **Absent `installer.kind` defaults to `setup-script` (forced).** Every existing
  fixture — and the uneditable gstack Source — omits `installer.kind`. A schema that
  required the discriminant would reject all current setup-script bundles. A
  `z.preprocess` injects `kind: "setup-script"` on the raw `installer` object before
  the discriminated union runs. The preprocess narrows `unknown` via `typeof`/spread
  into a `Record<string, unknown>` — no `any`, no casts (project rule).

- **`pinned_commit` is LOCKED-required on the setup-script arm for reproducibility.**
  Honest note: the clone command does not consume `pinned_commit` *directly* — the kit
  pins the clone to `source`@`pinned_commit`. Requiring it keeps every setup-script
  bundle reproducible by construction rather than at the upstream `main` tip.

- **CROSS-LEVEL INVARIANT — name it so a future edit doesn't break it.** The
  discriminant (`kind`) lives **inside** `installer`, while the conditionally-required
  `source`/`pinned_commit` live at the **top level**. So the discriminated union is
  built on the `installer` **sub-object**, and a bundle-level **`.superRefine`** —
  *not* a union arm — ties the top-level fields to the setup-script arm. A future edit
  must not migrate `source`/`pinned_commit` into the union: that would silently require
  them on `npx-skills` too. The asymmetry is guarded by a positive test (an npx-skills
  bundle omitting `source`/`pinned_commit` stays `conformant`) in both `bundle.test.ts`
  and the schema-tools `validate.test.ts`.

- **Lenient superset** (ADR-0024 stance): `.passthrough()` at both the bundle and
  installer levels, so author-specific keys (`added_in`, `scope`, `license`,
  `verify_paths`) ride through; strict only on the load-bearing coordinates. The
  gstack (setup-script, no `installer.kind`) and hyperframes (npx-skills) reference
  bundles validate `conformant:true` verbatim — the regression guard lives in
  `validate.test.ts`.

- **`validate()` stays non-rejecting** (ADR-0023/0024): a malformed bundle reports a
  located `ConformanceError` and the Source is still added with `conformant:false`.
  Absent/unparseable frontmatter (the nested `installer:` block parses through the
  full `yamlParse`) degrades to a located error, never a throw.

## Out of scope

`agent` and `instruction` remain ungated. The deploy-side loose parse
(`sources.ts` `?? ""` defaults) stays as defense-in-depth — this ADR only adds the
earlier validate-time gate. `parse()` stays lenient; only `validate()` goes strict.
