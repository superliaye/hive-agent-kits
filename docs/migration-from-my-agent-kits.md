# Migration plan — `my-agent-kits` → `bundled/personal/`

Evaluation of [E:\dev\GitRepos\my-agent-kits](file:///E:/dev/GitRepos/my-agent-kits) and a concrete plan to migrate its capabilities into Hive's `bundled/personal/` tree per ADR-0007.

## Source inventory

```
E:\dev\GitRepos\my-agent-kits\
├── .apm/skills/<name>/SKILL.md       — 10 skills (4 external-upstream, 6 own)
├── .apm/instructions/<name>.instructions.md — 3 instructions (always-loaded conduct rules)
├── .apm/plugins/<name>.plugin.md     — 1 plugin pointer (superpowers)
├── .apm/bundles/<name>.bundle.md     — 2 external-installer bundles (gstack, hyperframes)
└── presets/<name>.yaml               — 3 preset selections (engineering, productivity, none)
```

## Mapping to Hive's four Capability kinds

| Source artifact | Hive kind | Action |
|---|---|---|
| `.apm/skills/<name>/SKILL.md` | **Skill** | Migrate to `bundled/personal/skills/<name>/SKILL.md` |
| `.apm/instructions/<name>.instructions.md` | **Prompt Snippet** | Migrate to `bundled/personal/snippets/<name>/SNIPPET.md` |
| `.apm/plugins/<name>.plugin.md` | — | **Not migrated.** Claude Code-only mechanism |
| `.apm/bundles/<name>.bundle.md` | — | **Not migrated.** External installers for CLI skill dirs |
| `presets/<name>.yaml` | — | **Not migrated.** Informational; informs default Harness bindings |

## Skills to migrate (10)

| Name | Origin | Source-pointer? | Notes |
|---|---|---|---|
| `diagnose` | personal | Yes — `github.com/mattpocock/skills@1.0.0` | Has `scripts/` sibling |
| `grill-me` | personal | Yes — `github.com/mattpocock/skills@1.0.0` | |
| `grill-with-docs` | personal | Yes — `github.com/mattpocock/skills@1.0.0` | Has `ADR-FORMAT.md`, `CONTEXT-FORMAT.md` siblings — **this is the skill we used in this session** |
| `improve-codebase-architecture` | personal | Yes — `github.com/mattpocock/skills@1.0.0` | Has `LANGUAGE.md`, `DEEPENING.md`, `INTERFACE-DESIGN.md` siblings |
| `my-clean-code` | personal | No — own | `disable-model-invocation: true`, `allowed-tools` |
| `my-commit` | personal | No — own | manual-only |
| `my-commit-and-push` | personal | No — own | manual-only |
| `my-create-pr` | personal | No — own | manual-only |
| `my-explain` | personal | No — own | manual-only |
| `my-fix-build` | personal | No — own | manual-only, has `argument-hint` |

**Frontmatter transform per ADR-0007's Skill schema:**

```yaml
# BEFORE (my-agent-kits .apm/skills/grill-with-docs/SKILL.md)
---
description: Grilling session that challenges...
added_in: 0.4.0
upstream: https://github.com/mattpocock/skills
upstream_version: 1.0.0
---

# AFTER (hive-v2 bundled/personal/skills/grill-with-docs/SKILL.md)
---
name: grill-with-docs
description: Grilling session that challenges...
tags: [planning, docs, design]
source:
  url: github.com/mattpocock/skills
  ref: "1.0.0"
  fetchedAt: 2026-05-16
---
```

Transforms:
- Add explicit `name:` (was implied from folder name).
- Add `tags:` (curated per skill — see "tags assignment" below).
- `upstream` + `upstream_version` → `source: { url, ref, fetchedAt }`.
- Drop `added_in:` (kit-specific versioning).
- For own skills (`my-*`): no `source` block.

## Prompt Snippets to migrate (3)

| Name | Origin | Notes |
|---|---|---|
| `core` | personal | Repo-agnostic conduct rules (no emojis, evergreen docs, ask before git mutations) |
| `typescript` | personal | TypeScript strict — no `any`, no `as any` |
| `karpathy` | personal | Karpathy's four mantras (think first, simplicity, surgical, goal-driven). `derived_from: github.com/forrestchang/andrej-karpathy-skills` |

**Frontmatter transform:**

```yaml
# BEFORE (.apm/instructions/karpathy.instructions.md)
---
description: Karpathy's behavioral guidelines...
applyTo: "**"
added_in: 0.2.1
derived_from: https://github.com/forrestchang/andrej-karpathy-skills
synced: false
---

# AFTER (bundled/personal/snippets/karpathy/SNIPPET.md)
---
name: karpathy
description: Karpathy's behavioral guidelines for LLM-assisted coding...
tags: [voice, coding, methodology]
source:
  url: github.com/forrestchang/andrej-karpathy-skills
  ref: derived
  fetchedAt: 2026-05-16
---
```

Transforms:
- Add explicit `name:`.
- `applyTo: "**"` → drop (Hive Snippets are consulted by Agent Manager, not glob-scoped at runtime).
  - For `typescript` (`applyTo: "**/*.{ts,tsx}"`) the semantic intent — "use this when authoring an agent that works on TS code" — is captured by `tags: [voice, typescript]`. The AM picks Snippets by description + tags during Harness authoring; no `applyTo` field needed.
- `derived_from:` → `source:` block.
- Drop `synced:`, `added_in:`.

## Tags assignment

| Skill | Suggested tags |
|---|---|
| `diagnose` | `[debugging, methodology]` |
| `grill-me` | `[planning, design]` |
| `grill-with-docs` | `[planning, docs, design]` |
| `improve-codebase-architecture` | `[refactoring, architecture]` |
| `my-clean-code` | `[code-quality, refactoring]` |
| `my-commit` | `[git, workflow]` |
| `my-commit-and-push` | `[git, workflow]` |
| `my-create-pr` | `[git, workflow]` |
| `my-explain` | `[understanding]` |
| `my-fix-build` | `[debugging, build]` |

| Snippet | Suggested tags |
|---|---|
| `core` | `[voice, conduct, baseline]` |
| `typescript` | `[voice, typescript]` |
| `karpathy` | `[voice, coding, methodology]` |

## Inclusion principle

**All capabilities go in the repo.** Enablement is per-Agent, controlled by the Agent Manager when authoring a Harness and by the user through the Settings UI's binding checkboxes. There is no harm in shipping a large pool — the Agent Manager evaluating more options is intended behavior, not a cost. Unbound capabilities consume no runtime resources.

This means the migration includes content the bundles only point at (superpowers, gstack, hyperframes), not just the bundle metadata files. The bundle metadata files in `my-agent-kits` are *installer recipes* (they fetch from external upstreams); we vendor what they install.

## Phase 1 — Direct content from `my-agent-kits/.apm/` (13 items)

The 10 skills and 3 instructions covered above are **direct content** in the source repo. Copy + transform per the tables above. Self-contained; nothing external to fetch. Suitable for immediate execution.

## Phase 2 — Vendor external bundles into the bundled set (~46+ items)

`superpowers.plugin.md`, `gstack.bundle.md`, and `hyperframes.bundle.md` are installer recipes pointing at external upstreams. To honor the inclusion principle, we vendor the actual skill content from those upstreams at the recipes' pinned versions.

| Bundle | Upstream | Approximate skill count | Heavy deps? |
|---|---|---|---|
| `superpowers` | `anthropics/claude-plugins-official` (marketplace) | ~6 (TDD, debug, brainstorm, plan, review, skill-authoring) | None — pure markdown |
| `gstack` | `garrytan/gstack@dc6252d1df7f1f650ea6e9b2bba7d08fab5de902` | 30+ (planning, design, QA, ship, security, browser, knowledge) | Bun, Playwright Chromium for some skills |
| `hyperframes` | `heygen-com/hyperframes` npm | ~10 (composition, CLI, media, registry, runtime adapters) | Node ≥22, FFmpeg for some skills |

Phase 2 execution (separately scoped from Phase 1):

1. **Build the refresh script first** (`pnpm refresh:skills`). It iterates skills with `source:` blocks, fetches the latest body from the upstream at the pinned ref, overwrites, prompts the maintainer to commit. The script also handles the initial vendoring (fetch + transform + place).
2. **For each upstream**, write the source pin into a small config the refresh script reads (or hand-curate a manifest of which upstream skills to vendor). The pin is a git SHA, a git tag, or an npm version.
3. **Run the refresh script**: it clones the upstream (or `npm pack`s for the npm one), discovers all SKILL.md files, transforms frontmatter to Hive's schema, places each as `bundled/personal/skills/<name>/SKILL.md` with siblings preserved, and writes the `source:` block pinning to the upstream ref.
4. **Manually fold in `compatibility.system` for heavy-deps skills** — e.g., the gstack browser skills declare `binaries: [bun, playwright-chromium]`; the hyperframes render skills declare `binaries: [ffmpeg, node]`, `platforms: [...]`. These are added by the maintainer after the refresh, since upstream skills don't carry Hive's compatibility schema yet.
5. **Review for name collisions** in the bundled set. `gstack-review` and `my-create-pr` don't collide; but if two upstreams ever ship a skill with the same name (e.g., both have a `review`), the same-layer collision rule from ADR-0007 fires.
6. **Commit** in logical chunks (one per upstream, or one large vendoring commit — maintainer's call).

**`presets/{engineering, productivity, none}.yaml`** in `my-agent-kits` are not migrated as capabilities. They informed the Phase 1 binding-suggestions table above (which skills to bind to the bundled Root vs Agent Manager). The selection lists themselves don't have a home in Hive — bindings live on each Agent's Harness, populated at agent-creation time by the Agent Manager (or by the bundled Harness's defaults for Root/AM).

## Design gaps surfaced by the migration

These don't block migration but need resolution before the migrated capabilities behave correctly at runtime.

### G7-1 — Manual-only skills (`disable-model-invocation: true`)

Six of the ten skills (`my-*`) declare `disable-model-invocation: true`. In Claude Code these are slash commands — the user types `/my-commit`, and the skill body is the prompt that runs. The model never auto-selects them.

ADR-0007's Skill manifest does not model this. Options:
- Add `manualInvocationOnly: true` to the Skill schema. When set, the description is **not** included in the always-on system prompt; the body is only loaded when the user invokes by name (slash command in UI, or `load_skill("my-commit")` if exposed to the model).
- Treat all migrated `my-*` skills as model-invocable but with descriptions that explicitly cue "Use when the user types /my-commit" — relies on the model's discipline.
- **Recommend the schema extension** (the first option). It honors the original author's intent and keeps slash-command UX explicit. Update ADR-0007's Skill schema to add the optional flag.

### G7-2 — Skill-level `allowed-tools` restriction

The `my-*` skills declare e.g. `allowed-tools: Bash(git:*)` — a restriction that says "this skill should only need git Bash calls." In Claude Code, this scopes the Tool surface for the duration of the skill's execution.

Hive's Permission System (G2 in ADR-0003) is the natural home, but doesn't exist yet. Recommendation:
- Preserve the field as `allowedTools` in the Skill manifest (optional list of tool-name globs).
- Today: informational only; surfaced in the Settings UI as a hint of expected scope.
- v1.1, when G2 lands: the Permission System reads this to scope Tool access during skill-body execution.

### G7-3 — `argument-hint` for slash-command skills

`my-fix-build` has `argument-hint: [optional: specific package]`. Used by Claude Code to prompt the user for the slash command's argument. In Hive, the UI's slash-command surface would surface the same hint.

Recommendation: preserve as `argumentHint: string` in the Skill manifest. UI-only field. No runtime effect.

### G7-4 — Snippet `applyTo` glob hint

The instruction files use `applyTo: "**/*.{ts,tsx}"` to scope when the instruction loads (Claude Code reads this on file-context match). Hive Snippets are consulted by Agent Manager at Harness authoring, not glob-matched at runtime.

Recommendation: drop the field on migration. The semantic intent (scope to TS authoring) is captured by `tags: [voice, typescript]`. The Agent Manager picks Snippets by description + tags during Harness authoring.

### G7-5 — External skill refresh script

Four skills carry `source: { url, ref }` blocks pointing at upstream repos. ADR-0007 specifies that vendored skills are refreshed by a maintainer script (`pnpm refresh:skills`) — not yet implemented.

Recommendation: defer. Migration is a one-shot copy. The refresh script is a separate piece of tooling (small Node script that iterates `bundled/personal/skills/*/SKILL.md`, finds `source:` blocks, fetches the latest, overwrites the body, prompts the maintainer to commit). Build it when the first refresh need lands.

## Default Harness bindings (informed by presets)

The bundled `bundled/agents/root/HARNESS.md` and `bundled/agents/agent-manager/HARNESS.md` should arrive pre-equipped with sensible defaults. Suggested initial bindings:

**Root Agent** (entry point + dispatch):
```yaml
bindings:
  skills:
    - diagnose
    - grill-me
    - my-commit
    - my-commit-and-push
    - my-create-pr
    - my-explain
    - my-fix-build
    - my-clean-code
  snippets: []     # Root is not the authoring agent; consumes prompt body directly
  tools:
    - memory_read
    - memory_write
    - ask_user
    - save_artifact
    - run_shell
    - load_skill
    - spawn_sub_agent     # Root-only
  mcp: []
```

**Agent Manager** (authors Worker Agents):
```yaml
bindings:
  skills:
    - grill-with-docs
    - improve-codebase-architecture
  snippets:                # AM consults these when authoring Harnesses
    - core
    - typescript
    - karpathy
  tools:
    - memory_read
    - memory_write
    - ask_user
    - create_agent          # AM-only
    - update_agent_harness  # AM-only
    - destroy_agent         # AM-only
    - load_skill
  mcp: []
```

These match the `engineering` preset (core+typescript+karpathy snippets, all engineering-flavored skills) but split appropriately between the two bundled Agents.

## Phase 1 execution order

Pure file operations plus a small ADR-0007 schema extension:

1. **Extend ADR-0007's Skill manifest schema** for the optional fields surfaced by G7-1/2/3:
   - `manualInvocationOnly?: boolean`
   - `allowedTools?: string[]`
   - `argumentHint?: string`
   (Snippets need no schema change; `applyTo` is dropped on migration.)
2. **Create `bundled/personal/skills/` and `bundled/personal/snippets/` directories.**
3. **Copy and transform each Skill folder** (10 skills): copy the full folder including sibling assets, rewrite SKILL.md frontmatter per the transform table above.
4. **Copy and transform each Instruction file** (3 snippets): rename `core.instructions.md` → `core/SNIPPET.md`, rewrite frontmatter.
5. **Write `bundled/agents/root/HARNESS.md` and `bundled/agents/agent-manager/HARNESS.md`** with default bindings (drawing on the suggestions above, plus the broader set Phase 2 brings in). Bodies (system prompts) start as stubs — the actual prompts come from the Agent Manager authoring once modules land.
6. **Run `bun run typecheck` and `bun test`** to verify nothing breaks (Capability modules don't exist yet, so this is mostly a sanity check on the rest of the codebase).
7. **Commit.** One commit for the schema extension, one for Phase 1 migration.

## Phase 2 execution order

1. **Build `pnpm refresh:skills`** — small Node script that handles both initial vendoring and subsequent refreshes.
2. **Vendor superpowers** from `anthropics/claude-plugins-official` at its current marketplace release.
3. **Vendor gstack** from `garrytan/gstack` at the pinned SHA from the original bundle metadata.
4. **Vendor hyperframes** from `heygen-com/hyperframes` at its current npm version.
5. **Add `compatibility.system` blocks** to the vendored skills that need them (gstack browser skills, hyperframes render skills).
6. **Verify no name collisions** at the bundled layer (ADR-0007 makes these load-time errors).
7. **Commit per upstream** (or one chunked commit) with the upstream pins recorded.

No code in `src/` needs to change for any of these steps — Capability modules are future work per ADR-0007. The migration prepares files so the future modules find them on first scan.

## Execution result (2026-05-16)

Phase 1 + Phase 2 executed in one shot, then revised after a post-implementation review. Final state: 25 Skills + 3 Snippets + 2 Harnesses in [bundled/](../bundled/).

**Phase 1 (13 items):**
- 10 Skills from `my-agent-kits/.apm/skills/` — direct copy with frontmatter transform (added `name`, `tags`, `source:` block for the 4 mattpocock-derived; converted `disable-model-invocation` → `manualInvocationOnly`, `allowed-tools` (string) → `allowedTools` (array), `argument-hint` → `argumentHint` for the 6 own `my-*` skills).
- 3 Snippets from `my-agent-kits/.apm/instructions/` — copied to `bundled/personal/snippets/<name>/SNIPPET.md`; `applyTo` field dropped (semantic intent captured by tags).
- 2 bundled Harness stubs ([root](../bundled/agents/root/HARNESS.md), [agent-manager](../bundled/agents/agent-manager/HARNESS.md)) — backend `native`, default bindings selected per the suggestion table, system prompts left as stubs (the Agent Manager rewrites these once it's running).

**Phase 2 (15 items):**
- Vendored via [scripts/vendor-from-local.ts](../scripts/vendor-from-local.ts), which reads from `~/.claude/skills/` (the user's local install) and writes to `bundled/personal/skills/<name>/` with transformed frontmatter and a `source:` block.
- **15 hyperframes-set skills** — sourced from `github.com/heygen-com/hyperframes@0.6.14` (npm version): `hyperframes`, `hyperframes-cli`, `hyperframes-media`, `hyperframes-registry`, `gsap`, `animejs`, `css-animations`, `lottie`, `three`, `waapi`, `tailwind`, `typegpu`, `remotion-to-hyperframes`, `website-to-hyperframes`, `contribute-catalog`.

**Phase 2 — gstack, reverted:**
Originally vendored 46 `gstack-*` skills from `garrytan/gstack@dc6252d1...`. **Removed during post-implementation review.** gstack commands (`/gstack-ship`, `/gstack-codex`, `/gstack-plan-ceo-review`, etc.) are dev-tooling CLI commands the developer invokes directly through their IDE — not skills the Hive Agent invokes as part of authoring or task execution. They belong in the developer's tool stack, not in Hive's agent-bound capability set. Available capability surfaces for these workflows: install gstack globally via its setup script and use it through a `claude-code`-backend Worker Agent (the CLI brings its own skills); or use the dev IDE directly.

The migration script's `classify` function no longer matches `gstack-*` skills; future runs will not re-introduce them.

**Phase 2 — superpowers, deferred:**
- The `my-agent-kits/.apm/plugins/superpowers.plugin.md` pointer references `anthropics/claude-plugins-official` with `plugin_name: superpowers`, but the current marketplace doesn't contain a plugin by that name. The marketplace has functionally adjacent plugins (`code-review`, `feature-dev`, `skill-creator`, `pr-review-toolkit`), but they're packaged as multi-component plugins (commands + agents + .claude-plugin/plugin.json), not single-SKILL.md skills. Vendoring them as Hive Skills requires extraction work distinct from this migration's scope.
- **Workaround in the interim**: the user has already installed individual skills equivalent to "superpowers" (e.g., `skill-creator`, `mcp-builder`) at `~/.claude/skills/`. These come from `github.com/anthropics/skills`. Future vendoring effort should target that upstream.

**Schema extensions to ADR-0007** (already landed):
- `manualInvocationOnly?: boolean` on the Skill schema.
- `allowedTools?: string[]` on the Skill schema.
- `argumentHint?: string` on the Skill schema.
- Inclusion principle section: "all capabilities go in the repo unconditionally; per-Agent selection happens at the binding seam."

**Verification:**
- `bun run tsc --noEmit` — passes (tsconfig excludes `bundled/` from typecheck, since vendored skills carry their own test fixtures with their own deps).
- `bun test` — all tests pass including the post-review additions ([bundled-schema.test.ts](../src/capabilities/__tests__/bundled-schema.test.ts) and [vendor-from-local.test.ts](../scripts/__tests__/vendor-from-local.test.ts)).

**Total `bundled/` size**: ~600 KB across 25 skill folders, 3 snippet folders, 2 harness folders. Negligible footprint per the inclusion principle.

## Post-review fixes (2026-05-16)

After the initial migration shipped, an engineering review surfaced findings; the following were applied:

- **CQ3** — gstack removed (above). gstack is dev tooling, not agent capability.
- **A2** — Hyperframes `source.ref` pinned to `0.6.14` (was `main`, non-deterministic).
- **CQ1** — Vendor script now reports dropped frontmatter keys with rationale (so future maintainers see what's lost).
- **CQ2** — YAML re-emission uses `lineWidth: 0` (one-line descriptions, stable diffs).
- **CQ3 (script hardening)** — Vendor script refuses symlinks and project-root-shaped sources (catches the 1.4 GB-trap repeat).
- **T1** — [bundled-schema.test.ts](../src/capabilities/__tests__/bundled-schema.test.ts) validates every manifest under `bundled/` against per-kind Zod schemas, enforces folder-name = manifest-name, and verifies Harness bindings resolve to bundled Capabilities. (Already caught one real regression: `diagnose/SKILL.md` whose frontmatter wasn't transformed in the original Phase 1.)
- **T2** — [vendor-from-local.test.ts](../scripts/__tests__/vendor-from-local.test.ts) covers the pure functions, especially the parens-respecting `splitAllowedToolsString` (a dormant bug that would have fired the first time an upstream used string-form `allowed-tools: "Bash(npm:*, rushx:*), Read"`).
- **A1 (withdrawn)** — Initial review claimed the AM Harness should bind all 71 skills. Wrong — bindings are runtime self-invocation; Registry visibility for composition uses dedicated browsing tools (`list_capabilities`, `get_capability_manifest`). ADR-0003 wording corrected; ADR-0007 notes the AM-restricted browsing tools.

**Still deferred:**
- **A3** — Replace vendor-from-local with clone-from-upstream `refresh:skills`. Not built until refresh is actually needed.
- **`compatibility.system` blocks** on heavy-deps vendored skills (FFmpeg for hyperframes render skills, Node ≥22, etc.). Migration doc Phase 2 step 5 remains skipped.

## Open questions before execution

1. Confirm the schema extensions in G7-1/2/3 are acceptable. (Cheapest path: yes — they're three small optional fields.)
2. Confirm dropping `applyTo` on Snippet migration is acceptable. (Reasoning is in G7-4.)
3. Should the bundled Root/AM Harnesses have their default prompt bodies authored now, or left as stubs to be filled when the Agent Manager comes online? (Recommend: stubs with clear placeholders, so v1 first-launch works but the actual prompts come from real AM authoring once modules land.)
