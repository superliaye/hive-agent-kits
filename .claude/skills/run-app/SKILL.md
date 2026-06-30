---
name: run-app
description: How to start the Hive dev stack (three visible terminals + Electron window) or build a shippable desktop app. Use when the user asks to "start the app", "show me the app", "run dev", "launch dev", "open Hive", "ship the app", "build production", "make the installer", or similar. Both workflows are one-command, self-verifying scripts; this skill says which command to run and the Windows quirks behind them.
---

# Running Hive

Two workflows, each a single self-contained script that installs deps, tears down any prior stack, launches, and verifies — you run one command and read the result:

- **dev** — three terminals (daemon, Vite, Electron) with HMR + the Electron window.
- **ship** — production build that produces a double-clickable `Hive.exe`.

The scripts derive the repo root themselves, so this works from any clone path on any machine. Never hardcode a path.

## Dev mode

### Agent: run via the PowerShell tool

```
pwsh -NoProfile -File scripts/dev.ps1              # full GUI stack (instance 0)
pwsh -NoProfile -File scripts/dev.ps1 -DaemonOnly  # daemon API only, no GUI
pwsh -NoProfile -File scripts/dev.ps1 -Instance 1  # a second, isolated stack
```

It installs deps, tears down any prior stack **for this instance**, launches, and verifies, then prints a STATUS block (specifics are in `scripts/dev.ps1`):

```
=== Hive dev stack (instance 0) ===
  daemon    :3117 /api/ready -> ok
  kit       /api/kit/catalog -> ok
  vite      :5173 -> ok
  electron  CDP :9333 -> ok (visual loop ready)
  runtime   C:\Users\<you>\.hive
  STATUS: PASS
```

Read that block. `STATUS: PASS` means everything it launched is up; `STATUS: FAIL` names what's missing. Exit code matches (0 / 1).

- **Default = full GUI stack** (daemon + Vite + Electron window), for full-loop verification. Windows open **minimized to the taskbar** and the Electron window shows **unfocused** (see [packages/shell/src/main.ts](../../../packages/shell/src/main.ts)), so a launch never steals focus from what you're doing. The Electron window also opens a dev-only DevTools port (`9333`, `!app.isPackaged`) that the visual loop attaches to — STATUS gates PASS on it.
- **`-DaemonOnly`** launches just the daemon and verifies `/api/ready` + the kit catalog — no Vite, no Electron. If a daemon is already healthy it reuses it (won't disturb a running GUI stack). Use when you only need the HTTP API.
- **`-Instance N`** (default 0) runs a **fully isolated** parallel stack: every port shifts by N (daemon `3117+N`, vite `5173+N`, electron CDP `9333+N`) and the runtime root becomes `~/.hive-N` (its own token, audit DB, deployed state). Teardown is instance-scoped, so relaunching one instance never disturbs another. This is how **multiple agents test in parallel** — each picks a distinct N. The cross-platform human launcher takes `--instance N` (`bun run dev:full -- --instance 1`).

Two hard rules are why this is a PowerShell `.ps1` and not the Bash tool or `bun run dev:full`:

- **Invoke it from the PowerShell tool, never the Bash tool.** Bash runs sandboxed/headless — `cmd /c start` and detached spawns succeed at the process level but no window ever renders.
- **Run `scripts/dev.ps1` directly; as the agent, do not go through `bun run dev:full`.** A bun-spawned child cannot create a visible window in the agent's non-interactive session. A `.ps1` run directly by the PowerShell tool can. (Verified: the identical launch fails when wrapped in bun, passes as a direct `pwsh -File`.)

### You, in your own terminal (any OS)

```
bun run dev:full                   # full GUI stack
bun run dev:full -- --daemon-only  # daemon only
```

Cross-platform (`scripts/dev.ts` — cmd windows on Windows, Terminal.app on macOS, x-terminal-emulator/gnome-terminal/xterm on Linux). Same phases; Windows terminals open minimized. On Windows you can also run `pwsh -File scripts/dev.ps1`.

### Stopping it

Stop **just this instance** with `pwsh -NoProfile -File scripts/dev.ps1 -Instance N -Stop` (omit `-Instance` for instance 0). It kills that instance's three titled `cmd` hosts + their bun/electron children and frees its ports, then prints `STATUS: STOPPED` — scoped to N, so a **parallel instance is never disturbed**. Run this after a visual-verification pass so the minimized `cmd /k` windows don't linger. (Rerunning the launcher also tears the instance down first, but then relaunches it — use `-Stop` when you just want it gone.) The daemon writes to `~/.hive-N/` (`~/.hive/` for instance 0).

## Visual loop

Hive is a **desktop app first** (it also renders as a plain web page). There are two ways to get pixels — **default to capturing the real Electron window**, and only drop to browser mode for a quick layout check.

### Capture the real desktop window (CDP) — the default

With the dev stack up, the Electron window exposes a DevTools port (`9333`, or `9333+N` for `-Instance N`). Attach to it and screenshot the **actual app** — live `window.__hive`, the real renderer and deployed state:

```
bun run scripts/screenshot.ts --cdp 9333 --out window.png            # instance 0
bun run scripts/screenshot.ts --cdp 9334 --out window.png            # instance 1
```

This is what to use when verifying anything desktop-specific (native title bar, system-accent, close-guard, IPC features). It needs the full stack up (the shell, so NOT `-DaemonOnly`). No token handling — the shell already authed the renderer. (Known caveat: under CDP, Playwright's color-scheme emulation renders **light** even though the window chrome is dark, so it isn't yet a faithful dark-theme capture — the DOM/state are the real window's.)

`scripts/screenshot.ts --cdp 9333+N` now yields a **verified non-blank** capture of the real window: the dev shell appends anti-occlusion / anti-backgrounding command-line switches (`--disable-features=CalculateNativeWinOcclusion` et al., dev-only, [packages/shell/src/main.ts](../../../packages/shell/src/main.ts)) so the visible-but-unfocused window keeps compositing instead of writing a black PNG. After writing, the script runs a content-check (decode the PNG, modal-color metric) and **fails loudly with "blank render"** if the frame is uniform — black or all-chrome — so a silent black capture can no longer pass. The anti-occlusion switches alone produce the verified frame on the dev machine; no fallback rung (bringToFront / capturePage / show-restore) was needed.

For **interactive** driving (clicks, typing, multi-step flows), the `electron-visual-loop` skill drives the same port with `agent-browser connect 9333`. `agent-browser` is **not installed by default** — use `npx agent-browser …` or `npm i -g agent-browser`. For a one-shot screenshot, `--cdp` above needs no extra install.

### Quick browser-mode check (the web rendering)

When you only need a fast layout/light-theme look and don't care about Electron-only surface, capture the Vite page headlessly instead — no interactive login:

```
bun run scripts/screenshot.ts [route] --out <path> [--full-page] [--wait <selector>] [--viewport WxH] [--vite <url>] [--daemon <url>]
bun run scripts/screenshot.ts / --out shot.png            # the app's root, default viewport
```

It seeds auth from `~/.hive/.token` (`HIVE_TOKEN` env overrides), folding the token plus the daemon URL into `?baseUrl=&token=` exactly as the UI's `resolveApiConfig()` reads them, then waits for the React app to mount in `#root` and writes the PNG. The token value is never printed. This is the **web** rendering: light theme, and `window.__hive` is absent so Electron-only features render their "unavailable" state — don't use it to judge desktop behavior. Requires Vite (:5173) and the daemon (:3117) serving; for `-Instance N` pass `--vite http://localhost:5173+N --daemon http://127.0.0.1:3117+N`. Exits non-zero on a missing token, a failed nav (stack down), or an empty render.

## Ship mode

```
bun run ship
```

`scripts/ship.ts` builds the UI, compiles the daemon to a self-contained binary, packages with `@electron/packager`, then verifies the artifacts and prints `STATUS: PASS` (with exact sizes). Output: `packages/shell/release/Hive-<platform>-x64/Hive.exe`, a double-clickable folder app — not an installer. Build steps and the packager-vs-electron-builder rationale are in the script header.

## Common failures and gotchas

The dev scripts already handle the frequent ones (missing `node_modules`, stale ports, the daemon-before-Electron stagger, clearing `ELECTRON_RUN_AS_NODE`). What's left:

| Symptom | Cause | Fix |
|---|---|---|
| `dev.ps1` STATUS: FAIL, daemon unreachable | Daemon crashed on boot — read its terminal window | Fix the error shown in the Hive Daemon window; rerun |
| Electron window opens but agents list is empty | Daemon came up after Electron probed it | Rerun — the script's stagger + health poll normally prevents this |
| `bun run ship` fails with "Cannot create symbolic link" during winCodeSign extraction | Using electron-builder on Windows without Developer Mode | Already worked around: `scripts/ship.ts` uses `@electron/packager` |
| `Hive.exe` from `packages/shell/release/` runs but no window appears | `ELECTRON_RUN_AS_NODE=1` inherited by the packaged app | Unset the env var globally, or wrap the launch in a `.bat` that clears it |
| Don't smoke-test `Hive.exe` from a background shell | GUI processes detach stdout — you can't observe boot state | Probe `http://127.0.0.1:3117/api/ready` instead |

## Querying the audit log

Two paths, both authoritative. Pick by context.

### Ad-hoc CLI query (fastest for one-off questions)

`sqlite3` CLI is on PATH (installed via `scoop install sqlite`). The daemon uses WAL mode, so concurrent readers are safe while the daemon is running. Always pass `-readonly`.

```bash
sqlite3 -readonly "$HOME/.hive/audit.db" "SELECT source, event_type, COUNT(*) FROM audit_events GROUP BY source, event_type;"
sqlite3 -readonly -header -column "$HOME/.hive/audit.db" "SELECT datetime(ts/1000000,'unixepoch') t, source, event_type, agent_id FROM audit_events ORDER BY ts DESC LIMIT 10;"
```

Schema reminder (table is `audit_events`): columns are `id, ts, seq, run_id, agent_id, source, event_type, payload, parent_event_id, prev_hash, signature`. `ts` is microseconds since epoch.

If `sqlite3` is missing on a different machine: `scoop install sqlite` (Windows), `brew install sqlite` (macOS), `apt install sqlite3` (Linux). Python's pre-installed `sqlite3` module is an always-available fallback: `python -c "import sqlite3, sys; ..."`.

### Programmatic query via the daemon (`GET /api/audit`)

The architectural answer per ADR-0004. Same redaction semantics (rows are redacted on write), same auth gate, available to any client.

```bash
TOKEN=$(cat ~/.hive/.token)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3117/api/audit?source=catalog&event_type=harness.updated&limit=10" | jq
```

Query params (validated by Zod, strict shape — unknown keys 400):

| Param | Type | Notes |
|---|---|---|
| `source` | enum | `run \| secrets \| mcp \| memory \| registry \| catalog \| lifecycle \| backend \| config \| agent-prefs \| thread` |
| `event_type` | string | exact match, e.g. `harness.updated` |
| `agent_id` | kebab-case | exact match |
| `run_id` | string | exact match |
| `since` / `until` | int microseconds | inclusive |
| `limit` | int 1..1000 | server clamps; default unlimited within filter |

Use this when:
- You're driving a test or script and want JSON back already parsed
- You need the bearer-auth gate (multi-process, future remote, future UI)
- You want consistency with whatever the future `hive audit query` CLI will do

Use the CLI when:
- You're poking around interactively
- The daemon isn't running and you just want to inspect persisted state
