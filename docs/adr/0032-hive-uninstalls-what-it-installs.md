# Hive uninstalls what it installs

status: proposed
relates-to: ADR-0025, ADR-0026, ADR-0029, ADR-0031

## What this ADR records

When a Capability lands through an external installer, Hive installs and
uninstalls it with the commands a user runs by hand. Such an installer is
the Claude Code or Codex CLI for a plugin, and the `skills` CLI for an
`npx-skills` bundle. Two earlier rules are retired:

- ADR-0029 kept plugin and bundle removal advisory, because the installers had
  no safe uninstall contract.
- ADR-0031 kept hand-written plugin pointers as manual installs.

Both plugin CLIs now have an uninstall command, and the `skills` CLI has a full
uninstall, so neither reason holds.

## Decision

- **Every plugin pointer is a managed install.** Sync-generated pointers
  (ADR-0031) and pointers a kit author writes install on Deploy the same way.
  The `managed_install` flag is gone. A pointer that still carries it parses
  unchanged.
- **Removal uninstalls.** When the user deselects an installer-owned Capability
  on a target that Hive owns (by its own record or the Ledger), the plan removes
  it:
  - Claude Code plugin: `claude plugin uninstall <plugin>@<marketplace> --scope user`.
  - Codex plugin: `codex plugin remove <plugin>@<marketplace>`.
  - `npx-skills` bundle: the full uninstall below.

  The marketplace stays registered. The task succeeds when the CLI no longer
  records the plugin, or when the bundle's verify paths are gone. A plugin
  removal also drops the name from the Ledger.
- **Hive records how it installed.** Deployment State keeps the installer
  coordinates of each install: the marketplace and plugin names, or the npx
  package, skills, and verify paths. Removal uses them first, so an uninstall
  still works after the Source or pointer is gone. A record without them uses
  the current pointer. With neither, the row stays "Manual removal required".
- **Hive claims what it installs.** If the user installed a plugin by hand
  before selecting it, Hive's install changes nothing but Hive now owns it, and a
  later deselect uninstalls it.
- **An `npx-skills` removal is a full uninstall.** The `skills` CLI installs every
  universal agent, Codex included, into the shared `~/.agents/skills`, and links
  Claude to it by default. It keeps a skill there while any other detected agent
  still has the skill. So the CLI cannot remove a skill from one agent while
  another keeps it. Hive therefore:
  - installs Claude with `--copy`, so the Claude copy does not depend on the
    folder Codex reads;
  - removes with `npx skills remove <skills> --global --yes`, the uninstall a
    user runs by hand, then reinstalls each target that keeps the bundle.

## Trade-offs

- The full uninstall also deletes copies other tools keep in their own folders,
  such as a user's own Cursor copy. Tools that read `~/.agents/skills` lose the
  skill on any Codex removal anyway.
- Removing a bundle from one target reinstalls it on the other, which costs a
  fetch and a second CLI run.
- Claiming a manual install can uninstall a plugin the user added before Hive.
  The user opts in by selecting it.
- A `setup-script` bundle has no installer that Hive runs. It stays a manual
  install and a manual removal.
