# Repo-specific Recipes run reviewed commands

status: proposed
relates-to: ADR-0032, ADR-0033

## What this ADR records

Some repositories install only through their own commands, so no generic Recipe can serve them.
gstack generates its skills with `./setup --host claude|codex` and removes every host with
`bin/gstack-uninstall`. ui-ux-pro-max is a Claude plugin, but on Codex it installs through its
own `uipro` CLI. A copied skill folder breaks in both cases. This ADR records how Hive runs those
commands, and where the trust boundary sits.

## Decision

- **A repo-specific Recipe projects one bundle Capability, named after the Tile.** Its pointer
  carries no commands, and its `targets` name the CLIs it installs on. Hive looks the commands up
  in the Tile's Recipe, which is shipped in Hive's source, so a kit or a repository cannot supply
  a command for Hive to run by writing a look-alike pointer. A bundle whose Tile has no installer
  stays a manual install. A CLI the repository serves through a generic pattern keeps that
  pattern's pointer: ui-ux-pro-max projects the Claude plugin pointer the marketplace Recipe
  writes, plus a Codex-only bundle, and the Tile's whole unit ties them.
- **The Recipe declares an installer per CLI.** Each target has its own install command, its own
  uninstall command, and the paths that prove it is installed. An uninstall that removes every
  host at once is declared `all-targets`. Hive then runs it once and reinstalls each target that
  keeps the Capability, the same shape as ADR-0032's npx full uninstall.
- **Commands run from a Hive-owned checkout, never the Mirror.** When a Recipe needs the
  repository on disk, Sync copies the tree into the Mirror's `checkout/`. A Deploy copies that
  once, before the first step that uses it, into a private folder it deletes when it finishes,
  so a Sync or a Source delete during the Deploy cannot change what it installs. Every target
  installs from one checkout made from that copy. The checkout goes where the repository's
  documentation puts it for a desired target (gstack's Claude install is
  `~/.claude/skills/gstack`), else into a Hive-owned folder. When the desired targets move it,
  the targets that stay reinstall from the new place, and Hive deletes a Hive-owned checkout
  that no target uses. Repository scripts write into their checkout (gstack runs `bun install`
  and builds), so the Mirror stays read-only and its identity stays stable.
- **Commands run with the installers' child environment, pinned further.** `CODEX_HOME` names
  the Codex target. When the homes are redirected (tests, dev), `HOME` is the redirected parent,
  no variable but `PATH` may point into the real home outside it, and the `registry=` line of
  the real `~/.npmrc` is copied in, so a repository script cannot write the real home. Hive refuses
  to run them when only some homes are redirected. stdin answers only where an uninstaller asks
  a question (`uipro uninstall`).
- **Hive records how it installed.** Deployment State keeps the Tile, the checkout path, and the
  commit for each target, so an uninstall works after the Source is gone (ADR-0032). The
  agent-kit Ledger does not list Tile installs: it records a bundle for every CLI it manages, so
  it would report a Codex-only bundle as installed on Claude.
- **Only Tiles carry these Recipes (ADR-0033).** A pasted link runs one only when its locator is
  a Tile's locator, because that Recipe was reviewed for exactly that repository.

## Trade-offs

- A Tile's commands run whatever the repository's default branch holds at the last Sync. Review
  happens at Onboarding, not at each upstream commit.
- gstack's checkout is 72 MB and its setup downloads Bun packages and a Chromium build, so a
  first Deploy is slow, and it needs Bun on the user's PATH.
- `all-targets` uninstalls cost a reinstall of every kept target.
- A host that the repository's own uninstaller does not clean up stays the repository's bug.
  Hive checks the declared paths and reports a failed removal instead of deleting files itself.
