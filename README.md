# Hive

A desktop control surface for syncing capability Sources and deploying selected
Capabilities into Claude Code and Codex CLI homes. Full vocabulary in
[GLOSSARY.md](GLOSSARY.md).

When you add a plain repository URL, Hive resolves its default branch and saves
that branch in the Source Locator. Later Syncs keep that branch even if the
repository changes its default. A GitHub folder URL keeps its explicit branch.

## Prerequisites

[Bun](https://bun.sh) — the package manager and runtime.

## Development

```
bun install        # first-time setup (editor/types); dev:full also installs on each run
bun run dev:full
```

`dev:full` starts the daemon, the Vite UI server, and the Electron app window (with HMR), then prints a health `STATUS` block. Close any terminal window to stop that piece; the daemon writes to `~/.hive/`.

On Windows the launcher windows open minimized and the app window opens unfocused, so a launch doesn't steal focus.

### Tests and checks

```
bun test            # unit tests
bun run check       # Biome check (lint + format)
bun run verify      # full CI-equivalent verification
bun run format      # Biome format (writes)
```

## Build a distributable

```
bun run ship
```

Produces a runnable app folder at `packages/shell/release/Hive-<platform>-<arch>/` — double-click `Hive.exe` (or the platform equivalent). This is a copy-and-run folder, not an `.msi`/`.dmg` installer.

## Learn more

- [GLOSSARY.md](GLOSSARY.md) — domain vocabulary (use these terms exactly).
- [AGENTS.md](AGENTS.md) — conventions for AI coding agents.
- [docs/adr/](docs/adr/) — architectural decisions, numbered chronologically.
