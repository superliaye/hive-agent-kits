---
name: onboard-source
description: Onboards a repository as a Hive Tile. Reads its documented install and uninstall, recognizes it with the recipe lever, verifies install and uninstall on Claude Code and Codex in throwaway homes, picks a Recipe, adds the Tile, and records its fixture. Use when adding a repository to the Tile shelf, or when a Tile fixture must be re-recorded.
---

# Onboard a repository as a Tile

Onboarding (GLOSSARY.md, ADR-0033) decides how Hive installs one repository and pins that decision in a Tile and its recorded fixture. Run `bun run recipe-lever` and `bun test` from `packages/daemon`. Run each shell block below in one shell call, because its variables do not carry over to the next call.

## 1. Read what the repository tells a user to do

```sh
WORK=$(mktemp -d) && echo "$WORK" && git clone --depth 1 <url> "$WORK/repo" && git ls-remote --symref <url> HEAD
```

Read `README.md`, any install page under `docs/`, `.claude-plugin/`, `.agents/plugins/`, and any setup or install script. For Claude Code and for Codex, write down the documented install command, uninstall command, and where the docs say files land. A CLI the docs do not cover is a finding to report. Done when both CLIs have an entry. Remove the printed directory when the run ends.

## 2. Ask the lever which generic Recipe recognizes it

```sh
bun run recipe-lever <url> --compare-npx
```

- `Recipe` names the first generic Recipe that matched. `Sync fails not_recognized` means none matched, and the detail gives each Recipe's reason.
- `skipped:` lines name skills the published-skills Recipe left out.
- `Match` or `MISMATCH` compares Hive's skills with `npx skills add --list`. Only a published-skills result is comparable; a marketplace repository prints MISMATCH because npx lists its plugin's skills.
- `--ref <branch>` selects another branch. A subpath Tile is checked after step 5 adds it, with `bun run recipe-lever <tile-id>`.

Done when you can name the Recipe that matched, or say why none did.

## 3. Verify install and uninstall on each CLI, in throwaway homes

Keep every command away from `~/.claude`, `~/.codex`, and `~/.agents`. Remove the sandbox on every path, failures included.

For a plugin marketplace (the marketplace name is `name` in `.claude-plugin/marketplace.json` or `.agents/plugins/marketplace.json`):

```sh
SANDBOX=$(mktemp -d)
export CLAUDE_CONFIG_DIR="$SANDBOX/claude" CODEX_HOME="$SANDBOX/codex"
mkdir -p "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"
claude plugin marketplace add <owner>/<repo> </dev/null
claude plugin install <plugin>@<marketplace> --scope user </dev/null
claude plugin details <plugin>@<marketplace> </dev/null
claude plugin uninstall <plugin>@<marketplace> </dev/null
claude plugin marketplace remove <marketplace> </dev/null
codex plugin marketplace add <owner>/<repo> </dev/null
codex plugin add <plugin>@<marketplace> </dev/null
codex debug prompt-input </dev/null | grep -o '<plugin>:[A-Za-z0-9_-]*' | sort -u
codex plugin remove <plugin>@<marketplace> </dev/null
codex debug prompt-input </dev/null | grep -c '<plugin>:'
codex plugin marketplace remove <marketplace> </dev/null
rm -rf "$SANDBOX"
```

`claude plugin details` lists the skills, agents, and hooks Claude Code loads. The first `prompt-input` lists the skills Codex loads; the second must print 0.

For repository scripts (a `./setup`, an `install.sh`, an npx installer such as `npx -y skills@1.7.2 add <owner>/<repo> -g -a claude-code -y`):

```sh
SANDBOX=$(mktemp -d) && mkdir -p "$SANDBOX/home"
grep '^registry=' ~/.npmrc > "$SANDBOX/home/.npmrc"
git clone --depth 1 <url> "$SANDBOX/repo"
run() { (cd "$SANDBOX/repo" && env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME="$SANDBOX/home" "$@"); }
snap() { (cd "$SANDBOX/home" && find . \( -path ./.npm -o -path ./.cache \) -prune -o -type f -print | sort) > "$SANDBOX/$1"; }
snap before
run <documented Claude Code install> </dev/null; snap claude; diff "$SANDBOX/before" "$SANDBOX/claude"
run <documented Codex install> </dev/null; snap both; diff "$SANDBOX/claude" "$SANDBOX/both"
run codex debug prompt-input </dev/null | grep -c '<skill-name>'
run <documented uninstall> </dev/null; snap after; diff "$SANDBOX/before" "$SANDBOX/after"
rm -rf "$SANDBOX"
```

Done when, for each CLI, install made the CLI load the Capabilities and uninstall removed every file install added. Report any difference from what step 1 recorded.

## 4. Choose the Recipe

- **A generic Recipe fits.** It matched in step 2 and projects what step 3 installed. Use it. Narrow it to `unit: "whole"` when the skills only work together, as HyperFrames does.
- **A common shape no generic Recipe covers.** Generalize a new generic Recipe in `src/kit/recipes/`, test its recognition in `src/kit/__tests__/` the way `recipe.test.ts` does, and add it to `GENERIC_RECIPES` in `recipe.ts`, so every pasted link gets it. Then re-record every Tile, so each fixture's `generic` evidence is current.
- **Only the repository's own scripts install it.** That needs a repo-specific Recipe (`RepoRecipe` in `recipe.ts`), which only a Tile may hold because it may run the repository's scripts (ADR-0033, ADR-0034). Add it to `src/kit/recipes/repo-recipes.ts`, next to gstack and UI UX Pro Max:
  - `installer.targets` has an entry per CLI that step 3 verified. Each has `install` and `uninstall` command lists, the binaries they `require` (a missing one fails before anything runs), and the `proofs`: paths step 3 saw install add and uninstall remove. A command is `argv`, a `cwd` (`"checkout"` or `null`), and `stdin` for an uninstaller that asks a question. Declare `scope: "all-targets"` for an uninstaller that removes every CLI.
  - Set `installer.checkout` when the commands run inside the repository. `at` names the path the documentation gives for a CLI, as gstack's `~/.claude/skills/gstack`.
  - `recognize` checks the files the commands rely on and misses with a reason otherwise. The projection is a bundle pointer named after the Tile (`tileBundlePointer`), the tree copied to `CHECKOUT_ROOT` when there is a checkout, and any pointer a generic Recipe would write for a CLI that installs that way, as UI UX Pro Max's Claude plugin.
  - Test recognition in `src/kit/__tests__/repo-recipes.test.ts`, and install and uninstall over HTTP with a fake exec in `src/server/__tests__/routes-tile-installers.test.ts`.

## 5. Add the Tile and record its fixture

1. Add a `defineTile({ ... })` entry to `TILES` in `src/kit/recipes/tiles.ts`, with `tracking(<url>, MAIN)` or `tracking(<url>, MAIN, <subpath>)`.
2. Run `bun run recipe-lever <tile-id> --record`. It writes `src/kit/recipes/fixtures/<tile-id>.json`, and refuses when the Tile's Recipe does not recognize the repository, when replay does not reproduce the live run, or when the fixture exceeds 64 KiB.
3. Run `bun test src/kit/__tests__/tile-fixtures.test.ts src/kit/__tests__/tiles.test.ts`, then `bun test`. `tiles.test.ts` names the Tiles that narrow a generic Recipe to whole and the Tiles with a repo-specific Recipe, and requires every git Tile to track main; update it when the new Tile changes any of these.

Done when both runs pass and `git status` shows the new fixture.

## 6. Update the docs

From the repository root, run `git grep -n -i hyperframes -- '*.md'` and add the new Tile wherever a doc lists Tiles.

## Re-recording a fixture

A Tile fixture test that fails with `has no answer for "<key>"; re-record it` means a Recipe now asks something the recording never saw. Run the command it prints, then read `git diff` on the fixture. A changed `expect.tile` is a behavior change to justify in the PR. A changed `remote.commit` alone is upstream movement.

## Gotchas

- A skill that references `${CLAUDE_PLUGIN_ROOT}` works only inside a Claude Code plugin install, so the published-skills Recipe skips it and the lever reports it as needing a plugin runtime. Serve it through the plugin marketplace instead.
- A `SKILL.md` at the repository root makes the published-skills Recipe return only that skill, as `npx skills add` does without `--full-depth`. gstack's root skill is a router, and its real skills come from `./setup`, so it needs a repo-specific Recipe.
- Codex ignores a `SKILL.md` at a plugin root. Judge what Codex loads by `codex debug prompt-input`, not by the marketplace file.
- `codex exec` waits for stdin when stdin is an open pipe, as in a background shell. Close it with `</dev/null`.
- A sandboxed `HOME` hides `~/.npmrc`, so npx cannot reach the registry proxy. Copy its `registry=` line into the sandbox, as step 3 does.
- An uninstaller that removes every host at once (gstack's `bin/gstack-uninstall`) also removes the CLI you kept. Verify removal from one CLI as uninstall, then reinstall the kept CLI and check its files return.
- An interactive uninstall prompt can be answered on stdin: `printf 'y\n' | run <uninstall>`. Prefer a documented `--force` or `--yes` flag when one exists.
- The lever hides Git stderr. `Sync fails io` or `auth_or_repository_unavailable` on a repository that worked earlier is usually GitHub throttling the devbox. Check with `git ls-remote <url> HEAD`, wait a minute, and retry once.
- Codex prints `could not create PATH aliases` when `CODEX_HOME` is under `/tmp`. The warning is harmless.
