---
name: run-app
description: How to start the Hive dev stack (three visible terminals + Electron window) or build a shippable desktop app. Use when the user asks to "start the app", "show me the app", "run dev", "launch dev", "open Hive", "ship the app", "build production", "make the installer", or similar. Covers the Windows quirks the agent must know to actually succeed (sandboxed bash can't spawn windows; ELECTRON_RUN_AS_NODE breaks Electron silently).
---

# Running Hive

Two intended workflows: **dev** (interactive, three visible terminals + Electron window with HMR) and **ship** (production build that produces a double-clickable `Hive.exe`).

## Dev mode

### What the user runs

From their own interactive terminal:

```
cd e:\dev\GitRepos\hive-v2
bun run dev:full
```

Spawns three cmd windows + the Electron app window:
1. **Hive Daemon** — `bun --watch src/server/start.ts` (HMR via Bun)
2. **Hive UI (Vite)** — `bun run dev` in `ui/` (Vite HMR for renderer)
3. **Hive Shell (Electron)** — `bun run start` in `shell/` (no HMR; restart on edits to `shell/src/**`)

Closing any cmd window stops that piece. Daemon writes to `~/.hive/`.

### What I (the agent) run when asked to start it

**Critical: do not use the Bash tool.** Claude Code's bash runs in a sandboxed/headless context — `cmd /c start` and detached spawns succeed at the process level but no window ever renders. The PowerShell tool runs in a different context that *can* create visible windows.

Use the PowerShell tool with this exact shape:

```powershell
$repo = "e:\dev\GitRepos\hive-v2"

# Clear stale ports first.
Get-NetTCPConnection -State Listen -LocalPort 3117,5173 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# Daemon
Start-Process -FilePath cmd.exe -ArgumentList "/k","title Hive Daemon && cd /d $repo && bun --watch src/server/start.ts" -WindowStyle Normal
Start-Sleep -Seconds 2

# Vite
Start-Process -FilePath cmd.exe -ArgumentList "/k","title Hive UI Vite && cd /d $repo\ui && bun run dev" -WindowStyle Normal
Start-Sleep -Seconds 2

# Electron — must use a .bat because `set ELECTRON_RUN_AS_NODE=` chained with
# `&&` doesn't reliably clear the var on Windows cmd. Without clearing it,
# Electron starts in plain-Node mode and never creates a window.
$bat = "$env:TEMP\hive-shell-launch.bat"
@"
title Hive Shell Electron
cd /d $repo\shell
set ELECTRON_RUN_AS_NODE=
set HIVE_UI_MODE=dev
bun run start
"@ | Out-File -Encoding ASCII -FilePath $bat
Start-Process -FilePath cmd.exe -ArgumentList "/k",$bat -WindowStyle Normal
```

Equivalently, the user's `bun run dev:full` does the same thing via `scripts/dev.ts` (which writes per-job `.bat` files for the same reason).

### Verify the stack is healthy

After ~10s for first-boot:

```powershell
# Ports
Get-NetTCPConnection -State Listen -LocalPort 3117,5173 -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess | Format-Table

# Daemon /api/ready
(Invoke-WebRequest -Uri http://127.0.0.1:3117/api/ready -UseBasicParsing).Content

# Token + agents
$token = (Get-Content "$env:USERPROFILE\.hive\.token" -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }
(Invoke-WebRequest -Uri http://127.0.0.1:3117/api/agents -Headers $headers -UseBasicParsing).Content

# Electron window
Get-Process | Where-Object { $_.MainWindowTitle -like '*Hive*' -and $_.ProcessName -like 'electron*' } |
  Select-Object Id, ProcessName, MainWindowTitle | Format-Table
```

Expected: ports listening, `{"status":"ok"}`, JSON with `root` + `agent-manager`, an electron.exe with `MainWindowTitle = "Hive"`.

### Tearing down

```powershell
Get-Process -Name bun,electron -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 3117,5173 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```

Closing the cmd windows on the desktop is the user-facing teardown — same effect.

## Ship mode

```
bun run ship
```

Runs `scripts/ship.ts`, which:
1. `cd ui && bun run build` → `ui/dist/`
2. `cd shell && bunx tsc` → `shell/dist/`
3. `bun build --compile --target=bun-windows-x64 src/server/start.ts --outfile shell/staging/hive-daemon.exe` (~109MB self-contained Bun binary, no Bun needed on target)
4. Copies `ui/dist/` → `shell/ui-dist/` and `bundled/` → `shell/staging/bundled/`
5. `bunx electron-packager .` produces `shell/release/Hive-win32-x64/`

Output: `shell/release/Hive-win32-x64/Hive.exe` — double-clickable, 188MB. The full folder is ~378MB (Electron baseline + UI bundle + bundled daemon + bundled capabilities).

**Why `@electron/packager` instead of `electron-builder`**: electron-builder always downloads `winCodeSign` on Windows; its 7z archive contains macOS `.dylib` symlinks 7za can't extract without Developer Mode or admin. packager dodges the signing-cache dance entirely. Trade-off: no installer (no `.msi`/`.dmg`) — just a runnable folder. Switch back to electron-builder when a signing cert + a build host with the right perms exist.

## Common failures and gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `bun run dev:full` runs, prints all three job lines, but no windows appear, ports never listen | Agent invoked it from the Bash tool — sandboxed/headless | Use the PowerShell tool instead, or have the user run it from their own terminal |
| Three cmd windows open but Electron window never appears | `ELECTRON_RUN_AS_NODE=1` set globally in user's env | Use a `.bat` file (not `set VAR= && ...`) to clear it. `scripts/dev.ts` already does this; ad-hoc PowerShell needs the .bat approach |
| `EADDRINUSE` on 3117 or 5173 | Stale daemon/Vite from a prior session | The Get-NetTCPConnection kill snippet above; or close the relevant cmd window |
| Electron window opens but agents list is empty | Daemon spawned by Electron's probe-then-spawn instead of attached (so the wrong runtime root or token) | Make sure the daemon terminal came up *first* (the 2s sleeps between Start-Process calls matter) |
| `bun run ship` fails with "Cannot create symbolic link" during winCodeSign extraction | Using electron-builder on Windows without Developer Mode | Already worked around: `scripts/ship.ts` uses `@electron/packager` |
| `Hive.exe` from `shell/release/` runs but no window appears | `ELECTRON_RUN_AS_NODE=1` again, this time inherited by the packaged app | Either unset the env var globally, or wrap the launch in a `.bat` that clears it |

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

## Process hygiene rules for the agent

- **Don't invoke `bun run dev:full` from the Bash tool** — see the failure table.
- **Don't try to smoke-test `Hive.exe` from a background-mode shell** — GUI processes detach stdout; you can't observe boot state. Probe `/api/ready` instead.
- **Always clear ports 3117 and 5173 before launching** — orphans from prior runs cause silent failures (the new daemon attaches to the stale one or the port bind fails).
- **The 2s stagger between terminal spawns matters** — daemon must be listening before Electron probes; Vite must be serving before Electron tries to load its URL.
- **Don't `kill` Electron processes via Get-Process -Name electron without filtering** — the user may have other Electron apps running (VS Code is built on Electron but reports `Code`, not `electron`, in process name; but be careful).
