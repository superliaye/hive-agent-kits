# Marketplace Sources and managed plugin installs

status: proposed; superseded-in-part by ADR-0032 — hand-written pointers install
too, and removal uninstalls
relates-to: ADR-0025, ADR-0029, ADR-0023

## What this ADR records

How Hive ingests a plugin marketplace repository as a Source and installs its
plugins itself, which ADR-0029 left open as "plugin-root ingestion". Until now a
plugin reached Hive only as a hand-written `.plugin.md` pointer inside a
capability kit, could target only Claude Code, and was never installed by a
Deploy: the Overview showed it as a manual install.

## Decision

- **A marketplace repository is a Source.** When a git Source selects the whole
  repository (subpath `.`) and its tree has no `capabilities/` but has
  `.claude-plugin/marketplace.json` and/or `.agents/plugins/marketplace.json`,
  Sync writes one `capabilities/plugins/<name>.plugin.md` pointer per listed plugin
  into the staged Mirror. Catalog, precedence, Selection, and Deploy then reuse the
  plugin path unchanged. Both files must name the same marketplace; otherwise
  nothing is ingested.
- **Targets come from the marketplace files.** A plugin listed in the Claude file
  targets Claude Code; one listed in the Codex file targets Codex. The pointer
  records them in `targets`. An undeclared pointer stays Claude-only, so every
  existing pointer keeps its behavior. This replaces ADR-0025's "the frontmatter
  carries no target".
- **Generated pointers are installed by Deploy, verbatim from the repository.**
  They record `source_commit`. The plan adds or updates a plugin on each declared
  target until Deployment State records the current pointer, so every newly synced commit is an update. The task runs
  the target CLI against the repository URL:
  - Claude Code: `plugin marketplace add`, `plugin marketplace update`,
    `plugin install`, `plugin update`.
  - Codex: `plugin marketplace add`, `plugin marketplace upgrade`, `plugin add`.

  The task succeeds only when the CLI records the plugin as installed.
- **Selection accepts both targets for a plugin.** Declared targets are Source
  content, and a Selection must survive its Source being unavailable (ADR-0029), so
  the store no longer strips a plugin's Codex target. The Overview and the plan
  narrow each plugin to its declared targets; an undeclared pair is ignored.

## Trade-offs

- The plan binds the pointer, not the installed bytes. Each CLI fetches the
  repository itself, so an install can be newer than the synced commit. Pinning
  would need each CLI to install an exact commit; `claude plugin marketplace add`
  has no ref option.
- A subpath Source or a working-tree Source is not ingested: the CLIs read a
  marketplace from a repository root, and a local path would make Claude Code load
  the user's working copy in place, outside Deploy.
