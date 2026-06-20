# 20. Monorepo workspace layout

## Status
Accepted

## Context
The repo held three packages — the daemon (root `package.json`, source in `src/`),
`ui/` (`hive-ui`), and `shell/` (`hive-shell`) — with no `workspaces` field. The
daemon sprawled across the repo root while ui/shell were self-contained folders,
so the layout read as a monorepo but had none of the wiring: three separate
`bun install`s, three lockfiles, and cross-package sharing done by reaching into
`../../src` and hand-copying wire types.

## Decision
Adopt a symmetric Bun workspace. All deployable units live under `packages/*`
(`daemon`, `ui`, `shell`, and a `contract` package for shared wire types). The
root `package.json` becomes orchestration-only (`workspaces`, scripts, repo-level
devDeps). `bundled/` moves under `packages/daemon/` to preserve the
`paths.ts` `../../bundled` resolution. A single root `bun.lock` replaces the three.
A `bunfig.toml` pins Bun's `linker = "hoisted"`: `@electron/packager` (run from
`packages/shell` during ship) resolves its own transitive deps by walking
`node_modules`, which Bun's default isolated linker hides inside a per-package
store. Hoisting lays out a flat root `node_modules` the packager can traverse.

## Consequences

- One `bun install` manages every member; the hoisted linker puts shared deps
  (Electron included) in root `node_modules`. The dev orchestration scripts scope
  their Electron process-kills to the repo root prefix so the sweep finds Electron
  wherever the linker places it.
- `@hive/contract` is the single source of truth for daemon↔UI kit + backend wire
  types, replacing the UI hand-mirrors and the wire-mirror drift tests. The
  appearance schema is owned separately by `@hive/theming` (ADR-0022), which both the
  daemon and the UI depend on; the daemon consumes its React-free `@hive/theming/schema`
  subpath. The interim cross-package reaches this layout once carried — the UI mirroring
  daemon wire types by hand, and a daemon `appearance-shape-drift` test importing the
  UI's theming types — are gone, replaced by these two shared packages.
- The tooling scan targets repoint from `src/` to `packages/daemon/src/`:
  `biome.json` `includes`, the no-floating-promises gate's `SRC_ROOT`, and the
  daemon's `tsconfig.json`. The config files (`biome.json`, `tsconfig.base.json`)
  and the dev/ship orchestration scripts stay at the repo root.
