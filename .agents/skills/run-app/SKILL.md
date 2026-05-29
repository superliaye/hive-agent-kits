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
pwsh -NoProfile -File scripts/dev.ps1              # full GUI stack (default)
pwsh -NoProfile -File scripts/dev.ps1 -DaemonOnly  # daemon API only, no GUI
```

It installs deps, tears down any prior stack, launches, and verifies, then prints a STATUS block (specifics are in `scripts/dev.ps1`):

```
=== Hive dev stack ===
  daemon    :3117 /api/ready -> ok
  agents    agent-manager, root
  vite      :5173 -> ok
  electron  running (window visible)
  STATUS: PASS
```

Read that block. `STATUS: PASS` means everything it launched is up; `STATUS: FAIL` names what's missing. Exit code matches (0 / 1).

- **Default = full GUI stack** (daemon + Vite + Electron window), for full-loop verification. Windows open **minimized to the taskbar** and the Electron window shows **unfocused** (see [shell/src/main.ts](../../../shell/src/main.ts)), so a launch never steals focus from what you're doing.
- **`-DaemonOnly`** launches just the daemon and verifies `/api/ready` + agents — no Vite, no Electron. If a daemon is already healthy it reuses it (won't disturb a running GUI stack). Use when you only need the HTTP API.

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

Rerun the script (it tears down any prior stack first) or close the cmd windows. The daemon writes to `~/.hive/`.

## Ship mode

```
bun run ship
```

`scripts/ship.ts` builds the UI, compiles the daemon to a self-contained binary, packages with `@electron/packager`, then verifies the artifacts and prints `STATUS: PASS` (with exact sizes). Output: `shell/release/Hive-<platform>-x64/Hive.exe`, a double-clickable folder app — not an installer. Build steps and the packager-vs-electron-builder rationale are in the script header.

## Common failures and gotchas

The dev scripts already handle the frequent ones (missing `node_modules`, stale ports, the daemon-before-Electron stagger, clearing `ELECTRON_RUN_AS_NODE`). What's left:

| Symptom | Cause | Fix |
|---|---|---|
| `dev.ps1` STATUS: FAIL, daemon unreachable | Daemon crashed on boot — read its terminal window | Fix the error shown in the Hive Daemon window; rerun |
| Electron window opens but agents list is empty | Daemon came up after Electron probed it | Rerun — the script's stagger + health poll normally prevents this |
| `bun run ship` fails with "Cannot create symbolic link" during winCodeSign extraction | Using electron-builder on Windows without Developer Mode | Already worked around: `scripts/ship.ts` uses `@electron/packager` |
| `Hive.exe` from `shell/release/` runs but no window appears | `ELECTRON_RUN_AS_NODE=1` inherited by the packaged app | Unset the env var globally, or wrap the launch in a `.bat` that clears it |
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
| `source` | enum | `run \| permission \| secrets \| mcp \| memory \| registry \| catalog \| lifecycle \| backend \| config \| gateway` |
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
