# Monorepo Workspace Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Hive's three loosely-coupled packages (root daemon, `ui/`, `shell/`) into a symmetric Bun workspace under `packages/*`, with one root lockfile and orchestration-only root `package.json`.

**Architecture:** Move the daemon out of the repo root into `packages/daemon/` (taking `bundled/` with it to preserve the `../../bundled` path invariant), move `ui/` → `packages/ui/` and `shell/` → `packages/shell/`, and scaffold an empty `packages/contract/` placeholder. Add a `workspaces` field so a single root `bun install` manages all members. Translate every hardcoded `src/`/`ui/`/`shell/`/`bundled/` path in the tooling (biome, the no-floating-promises gate, tsconfig) and the orchestration scripts (`dev.ts`, `dev.ps1`, `ship.ts`) to the new layout. This is a **mechanical refactor**: success = the existing green stays green (test suite, `tsc`, biome, `dev.ps1 -DaemonOnly`, `ship`).

**Tech Stack:** Bun workspaces, TypeScript, Biome 2.4, Electron, Vite. No CI exists — the `.githooks/pre-commit` hook is the only gate.

**This is ADR-worthy** (hard to reverse, surprising without context, real trade-off). ADR-0020 is written in Task 1 — ADR-0019 is already taken by the vendor-SDK CLI runtime change.

**Out of scope (deferred to Plan 2):** extracting the shared daemon↔UI wire types into `@hive/contract` and deleting the hand-mirrors + drift tests. Plan 1 keeps the single cross-package import working by repointing its relative path only.

**Out of scope (issue #9):** bringing `ui/**` under the biome lint gate (71 findings to clean). Plan 1 keeps biome scoped to the daemon; the new `packages/*` glob just makes #9 a one-line change later.

---

## Decisions locked for this plan (veto before execution)

| # | Decision | Rationale |
|---|---|---|
| D1 | Daemon package dir = `packages/daemon/`, name `@hive/daemon` | Matches CONTEXT.md vocabulary ("the daemon"). Scoped name lets `@hive/contract` be depended on cleanly in Plan 2. |
| D2 | `bundled/` moves to `packages/daemon/bundled/` | [paths.ts:18-21](../../src/lib/paths.ts#L18-L21) resolves it as `import.meta.dir/../../bundled` from `src/lib/`. Moving it with the daemon keeps that relative path valid — **zero change to `paths.ts`**. |
| D3 | Orchestration scripts (`dev.ts`, `dev.ps1`, `ship.ts`) stay at root `scripts/` | They orchestrate all three packages — repo-level, not daemon-level. |
| D4 | The no-float gate (`check-no-floating-suppressions.ts`) stays at root `scripts/`, rescoped to `packages/daemon/src` + `scripts` | It is the daemon's policy gate but the pre-commit hook calls it as a root script; root `scripts/` also needs guarding. |
| D5 | `ui` → `@hive/ui`, `shell` → `@hive/shell` (renamed from `hive-ui`/`hive-shell`) | Consistency; cosmetic, low-risk. |
| D6 | Single root `bun.lock`; delete `ui/bun.lock` + `shell/bun.lock` | Workspaces hoist to one lockfile. |
| D7 | `packages/contract/` is scaffolded empty (name `@hive/contract`, no deps, one placeholder export) | Establishes the workspace member now; Plan 2 fills it. |
| D8 | Biome stays scoped to daemon (`packages/daemon/src` + `scripts`), NOT ui | Issue #9 (ui under biome) is separate work; don't inject 71 lint failures into a structural refactor. |

---

## File Structure: before → after

**Before** (current):
```
hive-v2/
  package.json        # name "hive" — IS the daemon (Effect/Hono/Drizzle deps)
  tsconfig.json       # daemon tsconfig (no `include`, excludes node_modules + bundled)
  biome.json          # includes ["src/**","scripts/**"]
  bun.lock
  .gitattributes      # pins LF; names bun.lock, shell/bun.lock, ui/bun.lock
  src/                # daemon source
  scripts/            # dev.ts, ship.ts, dev.ps1, check-no-floating-suppressions.ts, vendor-from-local.ts
  bundled/            # vendored capabilities (daemon loads via paths.ts)
  ui/                 # name "hive-ui" — React/Vite, own tsconfig + bun.lock
  shell/              # name "hive-shell" — Electron, own tsconfig + bun.lock
  docs/
```

**After** (target):
```
hive-v2/
  package.json        # name "hive", private, "workspaces": ["packages/*"], orchestration scripts + devDeps (biome) only
  biome.json          # includes ["packages/daemon/src/**","scripts/**"]
  bun.lock            # single workspace lockfile
  .gitattributes      # pins LF; names bun.lock only
  tsconfig.base.json  # shared compiler options (extends target)
  scripts/            # dev.ts, ship.ts, dev.ps1, check-no-floating-suppressions.ts (+test)
                      #   (vendor-from-local.ts deleted — dead one-shot, Task 2)
  packages/
    daemon/
      package.json    # name "@hive/daemon", the Effect/Hono/Drizzle + vendor-SDK deps
      tsconfig.json   # extends ../../tsconfig.base.json, excludes bundled
      src/            # moved from repo-root src/
      bundled/        # moved from repo-root bundled/
    ui/               # moved from repo-root ui/; name "@hive/ui"
    shell/            # moved from repo-root shell/; name "@hive/shell"
    contract/         # NEW empty placeholder; name "@hive/contract"
      package.json
      src/index.ts
  docs/
```

**Key invariants preserved by the moves:**
- `packages/daemon/src/lib/paths.ts` → `../../bundled` = `packages/daemon/bundled` ✓ (D2)
- `packages/ui/src/api.ts` cross-package import changes `../../src/...` → `../../daemon/src/...` (one line; Task 4)
- `ship.ts` packaging root stays `packages/shell/` (Electron renderer/main live there)

---

## Known risks (handle explicitly, do not skip)

1. **Electron process-scoping path moves (NOT a hoist break — verified).** [dev.ts:151](../../scripts/dev.ts#L151) and [dev.ps1:69](../../scripts/dev.ps1#L69) scope `taskkill`/`Stop-Process` to `shell/node_modules` so only *this* repo's Electron is killed. Empirically tested on Bun 1.3.5 (no `bunfig.toml`): the workspace linker **hoists deps shared across members to root `node_modules`, but nests a dep unique to one member inside that member's own `node_modules`.** `electron` is unique to `@hive/shell`, so it lands at `packages/shell/node_modules/electron/dist/electron.exe` — the scoping logic is unchanged; only the path prefix `shell` → `packages/shell` changes. (Pointing `electronDir` at root `node_modules` would *break* the sweep — electron is not there.) Tasks 7+8 update the prefix and re-verify the kill works. Hardening option: scope to the repo root prefix (`REPO_ROOT + path.sep`) so the sweep survives a future Bun version that hoists electron — see Task 7 Step 2.
2. **Lockfile collapse must regenerate cleanly.** Deleting `ui/bun.lock` + `shell/bun.lock` then a root `bun install` must resolve all three dependency sets into one lockfile without version conflicts (e.g. both ui and shell pin `typescript ^5.6.3` — compatible). Task 6 verifies a clean install + that every package still builds.
3. **Root `tsconfig.json` currently doubles as the daemon's.** It has no `include`, so it would try to typecheck the whole tree. After the move it must become `packages/daemon/tsconfig.json` (daemon-scoped) plus a shared `tsconfig.base.json`. The per-package `tsc` invocations the validation harness already uses keep working.

---

## Pre-flight: baseline must be green

- [ ] **Task 0: Record the green baseline**

Run each and record the numbers in the commit message of Task 1 so regressions are visible:

```bash
bun install
bunx biome check
bun run check:no-float
bunx tsc --noEmit                 # daemon (root tsconfig today)
( cd ui && bunx tsc -b )
( cd shell && bunx tsc )
bun test                          # daemon suite (expect ~772 pass)
( cd ui && bun test )
```
Expected: all exit 0; biome clean; no-float clean; suites pass. If anything is red **stop** — fix or report before restructuring.

---

## Task 1: ADR-0020 + scaffold the workspace skeleton

**Files:**
- Create: `docs/adr/0020-monorepo-workspace-layout.md`
- Create: `packages/` (dir), `packages/contract/package.json`, `packages/contract/src/index.ts`
- Create: `tsconfig.base.json`
- Modify: `package.json` (add `workspaces`)

- [ ] **Step 1: Write ADR-0020**

```markdown
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

## Consequences
- One `bun install` manages every member; Electron and other deps hoist to root
  `node_modules` (dev orchestration scripts updated to scope process-kills there).
- `@hive/contract` (filled by a follow-on effort) becomes the single source of
  truth for daemon↔UI wire types, replacing hand-mirrors and drift tests.
- Every tooling root (`biome.json`, the no-floating-promises gate, tsconfig) and
  the dev/ship orchestration scripts move from `src/` to `packages/daemon/src/`.
```

- [ ] **Step 2: Create the shared base tsconfig**

`tsconfig.base.json` (lift the compiler options out of the current root `tsconfig.json` verbatim so the daemon's settings are unchanged):

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
```

- [ ] **Step 3: Scaffold the empty contract package**

`packages/contract/package.json`:
```json
{
  "name": "@hive/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/contract/src/index.ts`:
```ts
// Shared daemon<->UI wire contract. Populated by the contract-extraction effort
// (Plan 2); empty placeholder so the workspace member exists.
export {};
```

- [ ] **Step 4: Add the workspaces field to root package.json**

In `package.json`, add (top-level, after `"private": true`):
```json
  "workspaces": ["packages/*"],
```

- [ ] **Step 5: Verify the skeleton installs**

Run: `bun install`
Expected: exit 0; `@hive/contract` recognized as a workspace member (no error about missing packages).

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0020-monorepo-workspace-layout.md tsconfig.base.json packages/contract package.json bun.lock
git commit -m "chore(repo): scaffold packages/ workspace + ADR-0020 + contract placeholder"
```

---

## Task 2: Move the daemon into packages/daemon

**Files:**
- Move: `src/` → `packages/daemon/src/`
- Move: `bundled/` → `packages/daemon/bundled/`
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`
- Modify: `package.json` (strip daemon deps + daemon-only scripts), delete root `tsconfig.json`
- Delete: `scripts/vendor-from-local.ts` + `scripts/__tests__/vendor-from-local.test.ts` (dead one-shot whose `TARGET_ROOT` pointed at the moved root `bundled/`)

- [ ] **Step 1: git mv the daemon source and bundled tree, delete the dead vendoring one-shot**

```bash
mkdir -p packages/daemon
git mv src packages/daemon/src
git mv bundled packages/daemon/bundled
```

`scripts/vendor-from-local.ts` is a one-shot migration that already ran (its target skills are already in `bundled/`); its `TARGET_ROOT` (`import.meta.dir, "..", "bundled", ...`) pointed at the now-moved root `bundled/`. Delete it and its test rather than repoint a dead script:

```bash
git rm scripts/vendor-from-local.ts scripts/__tests__/vendor-from-local.test.ts
```

Note: this drops a few tests from the root-`scripts` suite — the daemon suite under `packages/daemon` is unaffected, so the per-package baselines in later tasks still match Task 0.

- [ ] **Step 2: Create packages/daemon/package.json**

Move the daemon's runtime deps out of root into here (these are the current root `dependencies` + the daemon-relevant devDeps):
```json
{
  "name": "@hive/daemon",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "bun test",
    "test:smoke": "HIVE_SMOKE=1 bun test",
    "start": "bun run src/server/start.ts",
    "dev": "bun --watch src/server/start.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.178",
    "@modelcontextprotocol/sdk": "1.29.0",
    "@openai/codex-sdk": "0.140.0",
    "drizzle-orm": "^0.45.2",
    "effect": "4.0.0-beta.75",
    "hono": "^4.12.19",
    "pino": "^10.3.1",
    "yaml": "^2.9.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "drizzle-kit": "^0.31.10"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Create packages/daemon/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "exclude": ["node_modules", "bundled"]
}
```

- [ ] **Step 4: Delete the root tsconfig.json and slim the root package.json**

Delete `tsconfig.json` (its options now live in `tsconfig.base.json`; the daemon's exclude lives in `packages/daemon/tsconfig.json`).

Root `package.json` becomes orchestration-only. Replace its `scripts`, `dependencies`, `devDependencies`, `peerDependencies` so it reads:
```json
{
  "name": "hive",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "prepare": "git config core.hooksPath .githooks",
    "test": "bun test",
    "check": "biome check",
    "check:no-float": "bun run scripts/check-no-floating-suppressions.ts",
    "format": "biome format --write",
    "dev:full": "bun run scripts/dev.ts",
    "ship": "bun run scripts/ship.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.16",
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```
(The root `start`/`dev` scripts that pointed at `src/server/start.ts` are dropped — use `dev:full` or run within `packages/daemon`. `@types/bun` stays at root because root `scripts/*.ts` run on Bun.)

- [ ] **Step 5: Verify daemon typechecks + tests in its new home**

Run:
```bash
bun install
( cd packages/daemon && bunx tsc --noEmit )
( cd packages/daemon && bun test )
```
Expected: tsc exit 0; suite passes with the same count as Task 0 (~772). The `paths.ts` `../../bundled` resolution now points at `packages/daemon/bundled` — a catalog/capabilities test exercising the bundled tree (e.g. `bun test packages/daemon/src/capabilities/__tests__/bundled-schema.test.ts`) must pass, proving D2.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(repo): move daemon + bundled into packages/daemon"
```

---

## Task 3: Move ui and shell into packages/

**Files:**
- Move: `ui/` → `packages/ui/`, `shell/` → `packages/shell/`
- Modify: `.gitignore` (repoint root-anchored `shell/*` + `ui/.vite` globs)
- Modify: `packages/ui/package.json` (name), `packages/shell/package.json` (name), `packages/ui/tsconfig.json` (extends base if it referenced a root path)

- [ ] **Step 1: Clean stale build artifacts, repoint `.gitignore`, then git mv**

The working tree may hold ignored build outputs under `shell/` (`release/`, `staging/`, `ui-dist/`, `build-resources/`, `test-results/`, `playwright-report/`). `git mv shell …` renames the directory on disk, dragging those untracked dirs to `packages/shell/…` where the old root-anchored `.gitignore` globs no longer match them — so they'd surface as stageable junk. Clean them, repoint the globs, **then** move:

```bash
rm -rf shell/release shell/staging shell/ui-dist shell/build-resources shell/test-results shell/test-results.json shell/playwright-report
```

In `.gitignore`, repoint the root-anchored globs (the unanchored ones — `node_modules/`, `dist/`, `*.db`, `*.tsbuildinfo` — match at any depth and survive the move untouched):
```
packages/shell/test-results/
packages/shell/test-results.json
packages/shell/playwright-report/
packages/shell/staging/
packages/shell/ui-dist/
packages/shell/release/
packages/shell/build-resources/
packages/ui/.vite/
```

Then move:
```bash
git mv ui packages/ui
git mv shell packages/shell
```

- [ ] **Step 2: Rename the packages**

`packages/ui/package.json`: `"name": "hive-ui"` → `"name": "@hive/ui"`.
`packages/shell/package.json`: `"name": "hive-shell"` → `"name": "@hive/shell"`.

- [ ] **Step 3: Verify ui/shell tsconfigs are self-contained**

Read `packages/ui/tsconfig.json` and `packages/shell/tsconfig.json`. They already carry their own compiler options (React JSX / Electron-Node) and do not `extends` the old root tsconfig, so no path edit is needed. If either references `../tsconfig.json`, repoint to `../../tsconfig.base.json`.

- [ ] **Step 4: Verify both build**

Run:
```bash
bun install
( cd packages/ui && bunx tsc -b )
( cd packages/shell && bunx tsc )
```
Expected: ui `tsc -b` will FAIL on the one cross-package import (`../../src/...` no longer resolves) — that's the next task. shell `tsc` exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(repo): move ui + shell into packages/, scope names to @hive/*"
```

---

## Task 4: Repoint the one cross-package import

**Files:**
- Modify: `packages/ui/src/api.ts:150`

- [ ] **Step 1: Update the relative path**

In `packages/ui/src/api.ts`, line 150:
```ts
import type { ContentBlock } from "../../src/lib/messages.ts";
```
becomes:
```ts
import type { ContentBlock } from "../../daemon/src/lib/messages.ts";
```
(Leave the comment above it; Plan 2 replaces this reach with `@hive/contract`.)

- [ ] **Step 2: Verify ui typechecks**

Run: `( cd packages/ui && bunx tsc -b )`
Expected: exit 0.

- [ ] **Step 3: Verify ui tests still pass**

Run: `( cd packages/ui && bun test )`
Expected: same pass count as Task 0.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/api.ts
git commit -m "refactor(ui): repoint daemon ContentBlock import to packages/daemon"
```

---

## Task 5: Move the daemon-specific tooling roots

**Files:**
- Modify: `biome.json`
- Modify: `scripts/check-no-floating-suppressions.ts`

- [ ] **Step 1: Update biome includes**

`biome.json` line 5:
```json
    "includes": ["src/**", "scripts/**"]
```
becomes:
```json
    "includes": ["packages/daemon/src/**", "scripts/**"]
```
(Daemon only — D8. The contract package is empty; add `packages/contract/src/**` here only once Plan 2 fills it.)

- [ ] **Step 2: Update the no-float gate scan roots**

In `scripts/check-no-floating-suppressions.ts`, lines 25-27:
```ts
const SRC_ROOT = resolve(import.meta.dir, "..", "src");
const SCRIPTS_ROOT = resolve(import.meta.dir);
const SCAN_ROOTS = [SRC_ROOT, SCRIPTS_ROOT];
```
become:
```ts
const SRC_ROOT = resolve(import.meta.dir, "..", "packages", "daemon", "src");
const SCRIPTS_ROOT = resolve(import.meta.dir);
const SCAN_ROOTS = [SRC_ROOT, SCRIPTS_ROOT];
```
And update the `inScope` path check (lines 30-38) so it still matches the daemon source. `sf.fileName.includes("/src/")` / `"\\src\\"` still matches `packages/daemon/src/...`, and `"/scripts/"` still matches root `scripts/`, so **no change to `inScope` is required** — confirm by reading it, don't edit blindly.

- [ ] **Step 3: Verify biome + no-float still clean against the moved daemon**

Run:
```bash
bunx biome check
bun run check:no-float
```
Expected: both exit 0, same as Task 0 (the gate now walks `packages/daemon/src` + `scripts`).

- [ ] **Step 4: Commit**

```bash
git add biome.json scripts/check-no-floating-suppressions.ts
git commit -m "chore(tooling): repoint biome + no-float gate to packages/daemon/src"
```

---

## Task 6: Collapse the three lockfiles into one

**Files:**
- Delete: `packages/ui/bun.lock`, `packages/shell/bun.lock`
- Modify: `.gitattributes`
- Regenerate: root `bun.lock`

- [ ] **Step 1: Remove the per-package lockfiles**

```bash
git rm packages/ui/bun.lock packages/shell/bun.lock
```

- [ ] **Step 2: Update .gitattributes**

Replace the three lockfile lines (9-11) with one:
```
bun.lock  linguist-generated -diff
```

- [ ] **Step 3: Regenerate the single workspace lockfile**

```bash
rm -f bun.lock
bun install
```
Expected: a single root `bun.lock` resolving daemon + ui + shell + contract; exit 0; no peer-dep conflict errors.

- [ ] **Step 4: Verify every package still builds off the hoisted install**

Run:
```bash
( cd packages/daemon && bunx tsc --noEmit && bun test )
( cd packages/ui && bunx tsc -b && bun test )
( cd packages/shell && bunx tsc )
```
Expected: all exit 0; suites match Task 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(repo): collapse ui/shell lockfiles into single workspace bun.lock"
```

---

## Task 7: Update the orchestration scripts' paths

**Files:**
- Modify: `scripts/dev.ts`, `scripts/dev.ps1`, `scripts/ship.ts`

- [ ] **Step 1: dev.ts — repoint the three jobs + installAll**

In `scripts/dev.ts`:
- Job "Hive Daemon" `cmd` (line 33): `"bun --watch src/server/start.ts"` → `"bun --watch packages/daemon/src/server/start.ts"`.
- Job "Hive UI (Vite)" `cwd` (line 38): `"ui"` → `"packages/ui"`.
- Job "Hive Shell (Electron)" `cwd` (line 48): `"shell"` → `"packages/shell"`.
- `installAll` (lines 127-140): with workspaces, a single root `bun install` covers all members. Replace the per-target loop body so it runs **one** root install (drop the ui/shell entries):
```ts
function installAll(): void {
  console.log("→ bun install (workspace root)");
  const r = spawnSync("bun", ["install"], { cwd: REPO_ROOT, stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`bun install failed (exit ${r.status})`);
    process.exit(1);
  }
}
```

- [ ] **Step 2: dev.ts — repoint the Electron process-scoping (risk #1)**

`electronDir` (line 151) `resolve(REPO_ROOT, "shell", "node_modules")` → `resolve(REPO_ROOT, "packages", "shell", "node_modules")`. Bun 1.3.5 nests `electron` (unique to `@hive/shell`) in the member's own `node_modules` — verified — so this is a path-prefix update, not a logic change. The taskkill cmd-line regex (`hive-dev-|hive-shell-launch\.bat`) is unaffected.

Hardening (optional, recommended): instead of pinning the node_modules subdir, scope to the repo root so the sweep survives if a future Bun hoists electron to root. Set `electronDir = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep` (import `sep` from `node:path`) — the trailing separator stops `hive-v2` from matching a sibling clone `hive-v2-experiment`. Still repo-scoped, so VS Code / Slack Electron are spared.

- [ ] **Step 3: dev.ps1 — mirror the same path edits**

In `scripts/dev.ps1`:
- Daemon launch (line 90): `bun --watch src/server/start.ts` → `bun --watch packages/daemon/src/server/start.ts`.
- UI launch (line 93): `cd /d $repo\ui` → `cd /d $repo\packages\ui`.
- Shell launch (line 98): `cd /d $repo\shell` → `cd /d $repo\packages\shell`.
- `$electronDir` (line 69): `Join-Path $repo 'shell\node_modules'` → `Join-Path $repo 'packages\shell\node_modules'` (matches Bun's nested placement — risk #1).
- `installAll` targets (lines 50-54): drop the `ui`/`shell` entries; keep a single root `bun install`.

- [ ] **Step 4: ship.ts — repoint build inputs + staging**

In `scripts/ship.ts`:
- UI build cwd (line 43): `join(REPO_ROOT, "ui")` → `join(REPO_ROOT, "packages", "ui")`.
- shell tsc cwd (line 46): `join(REPO_ROOT, "shell")` → `join(REPO_ROOT, "packages", "shell")`.
- staging dir (line 49): `join(REPO_ROOT, "shell", "staging")` → `join(REPO_ROOT, "packages", "shell", "staging")`.
- daemon compile input (line 59): `"src/server/start.ts"` → `"packages/daemon/src/server/start.ts"`; outfile (line 60) `join("shell", "staging", ...)` → `join("packages", "shell", "staging", ...)`.
- uiDistTarget (line 66): `join(REPO_ROOT, "shell", "ui-dist")` → `join(REPO_ROOT, "packages", "shell", "ui-dist")`.
- cpSync ui dist (line 68): `join(REPO_ROOT, "ui", "dist")` → `join(REPO_ROOT, "packages", "ui", "dist")`.
- cpSync bundled (line 69): `join(REPO_ROOT, "bundled")` → `join(REPO_ROOT, "packages", "daemon", "bundled")`.
- releaseDir (line 72) + electron-packager cwd (line 100): `shell` → `packages/shell` (`join(REPO_ROOT, "packages", "shell", ...)`).
- The `--ignore=/src/` flag (line 97) is relative to the `packages/shell/` packaging root (shell's own `src/`) — unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev.ts scripts/dev.ps1 scripts/ship.ts
git commit -m "chore(scripts): repoint dev/ship orchestration to packages/* layout"
```

---

## Task 8: Full end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Clean install + all static gates**

```bash
rm -rf node_modules packages/*/node_modules
bun install
bunx biome check
bun run check:no-float
( cd packages/daemon && bunx tsc --noEmit )
( cd packages/ui && bunx tsc -b )
( cd packages/shell && bunx tsc )
```
Expected: every command exit 0.

- [ ] **Step 2: All test suites**

```bash
( cd packages/daemon && bun test )
( cd packages/ui && bun test )
```
Expected: pass counts match Task 0.

- [ ] **Step 3: Dev stack boots (daemon path + bundled resolution end-to-end)**

Run (PowerShell tool):
```
pwsh -NoProfile -File scripts/dev.ps1 -DaemonOnly
```
Expected: `STATUS: PASS` — daemon reaches `:3117/api/ready`, lists ≥1 agent (proves the daemon found `packages/daemon/bundled` and `paths.ts` still resolves).

- [ ] **Step 4: Full GUI stack + Electron sweep (risk #1)**

First, ground the path empirically (don't guess where Bun put electron):
```bash
ls packages/shell/node_modules/electron/dist/electron.exe   # expect: present (nested)
ls node_modules/electron 2>/dev/null                        # expect: absent (not hoisted)
```
If electron is instead at root `node_modules`, use the repo-root-prefix hardening from Task 7 Step 2.

Then run:
```
pwsh -NoProfile -File scripts/dev.ps1
```
Expected: `STATUS: PASS` with `electron running`. Then run it **again** immediately; the second run's teardown must kill the prior Electron (proves the `electronDir` → `packages/shell/node_modules` fix). If the second run reports a port conflict or a piled-up window, the scoping fix is wrong.

- [ ] **Step 5: Ship produces a runnable app**

Run: `bun run ship`
Expected: `STATUS: PASS` — the three artifacts (`Hive.exe`, `resources/hive-daemon.exe`, `resources/bundled`) all present (proves `ship.ts` staged `packages/daemon/bundled` and compiled `packages/daemon/src/server/start.ts`).

- [ ] **Step 6: Pre-commit hook still gates**

Run: `sh .githooks/pre-commit`
Expected: both `[pre-commit] no-floating-promises gate` and `[pre-commit] biome check` print and exit 0.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "test(repo): verify workspace restructure green end-to-end"
```

---

## Task 9: Update docs to the new layout

**Files:**
- Modify: `AGENTS.md`, `.claude/skills/run-app/SKILL.md`, `docs/effect-migration-plan.md`, `CONTEXT.md` (if it names paths), `README.md` (`shell/release/…` → `packages/shell/release/…`)

- [ ] **Step 1: AGENTS.md**

- "Vertical slices under `src/<module>/`" → `packages/daemon/src/<module>/`.
- The Audit/Trace path note (`src/lib/log.ts`) → `packages/daemon/src/lib/log.ts`.
- "Effect-TS is the default substrate for all daemon source (`src/`)" → `packages/daemon/src/`.
- Add a one-line "Repo layout" note pointing at ADR-0020.

- [ ] **Step 2: run-app skill**

In `.claude/skills/run-app/SKILL.md`, update any `src/server/start.ts`, `ui/`, `shell/`, `bundled/` references to the `packages/*` paths. The `pwsh -NoProfile -File scripts/dev.ps1` invocation is unchanged.

- [ ] **Step 3: effect-migration-plan.md**

Update the path references (`src/` + `scripts/` scope notes, `.githooks/pre-commit` description) to `packages/daemon/src`. Rewrite to current state — do not append a changelog note.

- [ ] **Step 4: Grep for stragglers**

```bash
grep -rnE '(^|[^/])\b(src/(server|lib|runs|backends|capabilities|catalog|config|audit)|(ui|shell)/(release|staging|dist|src|ui-dist))' docs/ AGENTS.md CONTEXT.md README.md .claude/skills 2>/dev/null
```
Fix any remaining root-relative `src/...` daemon paths and `shell/…`/`ui/…` paths in prose (e.g. `README.md` line 34's `shell/release/Hive-…` → `packages/shell/release/Hive-…`).

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md .claude/skills/run-app/SKILL.md docs/effect-migration-plan.md CONTEXT.md
git commit -m "docs: update paths for packages/* workspace layout"
```

---

## Self-review checklist (run before declaring Plan 1 done)

- [ ] `git grep -nE '"\.\./\.\./src/'` returns nothing (no stale repo-root `src` reaches).
- [ ] `git grep -n 'REPO_ROOT, "src"'` and `'REPO_ROOT, "bundled"'` (without `packages`) return nothing in `scripts/`.
- [ ] `git grep -nE 'import\.meta\.dir.*"bundled"'` returns nothing (the vendor-from-local idiom the `REPO_ROOT` grep misses — file is deleted, so this guards against re-introduction).
- [ ] `.gitignore` names `packages/shell/...` not root `shell/...`; after `bun run ship`, `git status --porcelain` shows no untracked `packages/shell/{release,staging,ui-dist}`.
- [ ] `biome.json` includes `packages/daemon/src/**`, not `src/**`.
- [ ] Exactly one `bun.lock` (`git ls-files '**/bun.lock' bun.lock` → one line).
- [ ] `dev.ps1 -DaemonOnly`, `dev.ps1`, and `ship` all PASS.
- [ ] Daemon test count unchanged from Task 0.

---

# Plan 2 (follow-on, outline only): Extract @hive/contract

**Goal:** Replace the daemon↔UI hand-mirrors and the single `../../daemon/src` reach with a shared `@hive/contract` package; delete the drift tests that become unnecessary.

**Why separate:** It is an independent subsystem with its own risk (changing the source of truth for wire types) and its own verification (drift tests deleted, both sides typecheck against one definition). It is *enabled* by Plan 1 but not required for "looks like a monorepo."

**Surface to move into `packages/contract/src/` (from the grep + api.ts read):**
| Type / const | Current daemon source | Current UI mirror | Drift guard today |
|---|---|---|---|
| `ContentBlock` | `lib/messages.ts` | direct import (`api.ts:150`) | none (import = guard) |
| `AgentBackend` enum | `lib/capability-types.ts` | `api.ts:9-11` | `lib/__tests__/agent-backend-wire-mirror.test.ts` |
| `ThinkingEffort`/`EFFORT_ORDER` | `lib/effort.ts` | `api.ts:89-106` | none |
| `SYMBOLIC_MODEL_LATEST/HIGHEST` | `runs/symbolic.ts` | `api.ts:113-114` | none |
| `BackendStatus` | `backend-probe/types.ts` | `api.ts:51-57` | none |
| `AvailableModel` | server wire (`/api/models`) | `api.ts:125-132` | none |
| command-allowlist field | `server/types.ts` (AgentDetailWire) | `api.ts:44` | none |
| AppearanceConfig bounds | `config/schema.ts` | `theming/serialize.ts:101` | `server/__tests__/appearance-shape-drift.test.ts` |

**Shape:** `@hive/contract` holds the Zod schemas + inferred types as the single source of truth. Daemon imports them (replacing local defs or re-exporting for back-compat); UI imports them (deleting the hand-written literals). The two drift tests (`agent-backend-wire-mirror`, `appearance-shape-drift`) are **deleted** — drift is impossible by construction.

**Risk to watch:** `@hive/contract` must stay dependency-light (Zod only) so the UI's Vite bundle doesn't accidentally pull daemon-only deps (Effect, Hono, the vendor SDKs) through the contract import graph. Keep schemas free of daemon-internal imports.
