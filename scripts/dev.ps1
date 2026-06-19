# Windows dev launcher: prepare deps, tear down any prior stack, open the stack
# terminals + Electron window (minimized, so they don't steal focus), then
# verify health and print one STATUS block. Run it directly (not through bun) so
# Start-Process creates real windows even from an agent's PowerShell tool:
#
#   pwsh -NoProfile -File scripts\dev.ps1              # full GUI stack (default)
#   pwsh -NoProfile -File scripts\dev.ps1 -DaemonOnly  # daemon API only, no GUI
#
# Windows open minimized to the taskbar; the Electron app window shows unfocused
# (see shell/src/main.ts) so a launch never pulls you out of what you're doing.
# The cross-platform `bun run dev:full` (scripts/dev.ts) is the equivalent for a
# human in a real terminal; this .ps1 exists because window creation from a
# bun-spawned child does not survive a non-interactive agent session.

param(
  # Launch only the daemon (port 3117) and verify its API; skip Vite + Electron.
  # If a healthy daemon is already running, reuse it instead of restarting, so
  # testing the API doesn't disturb an open GUI stack.
  [switch]$DaemonOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$DaemonPort = 3117
$VitePort = 5173

function Wait-For($timeoutSec, $check) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { if (& $check) { return $true } } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Daemon-only: reuse a healthy daemon if one is already up (don't restart it).
$reuse = $false
if ($DaemonOnly) {
  try { $reuse = (Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/ready" -UseBasicParsing -TimeoutSec 2).Content -match '"status"\s*:\s*"ok"' } catch { $reuse = $false }
  if ($reuse) { Write-Host "Daemon already healthy on :$DaemonPort - reusing (no restart)." }
}

if (-not $reuse) {
  # 1. Install. `bun install` is near-instant when the lockfile is satisfied; on
  #    a fresh/pulled repo it is the only thing that makes the processes bind
  #    their ports. One workspace-root install covers every member.
  Write-Host "-> bun install (workspace root)"
  Push-Location $repo
  bun install
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Host "bun install failed (exit $code)"; exit 1 }

  # 2. Fully tear down any prior Hive stack so relaunching restarts cleanly
  #    instead of piling up windows. taskkill /T on the titled cmd hosts
  #    cascades to their bun + Electron children; we then sweep any Electron
  #    orphaned from an already-closed window (scoped to this repo's binary, so
  #    other Electron apps like VS Code are untouched) and clear the ports.
  # Scope the Electron sweep to the repo root (trailing separator so a sibling
  # clone like hive-v2-experiment isn't matched). Bun nests electron under
  # packages\shell\node_modules; this prefix survives a future Bun that hoists
  # it to root node_modules.
  $electronDir = $repo + [IO.Path]::DirectorySeparatorChar
  # Scope the daemon/Vite cmd kill to this repo (their command line contains
  # `cd /d <repo>`) so a second clone or a stray window that merely mentions
  # "Hive Daemon" isn't force-killed. The Electron host goes through the temp
  # hive-shell-launch.bat, matched by name.
  $repoRe = [regex]::Escape($repo)
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match 'hive-shell-launch\.bat' -or ($_.CommandLine -match $repoRe -and $_.CommandLine -match 'Hive Daemon|Hive UI Vite') } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($electronDir, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -State Listen -LocalPort $DaemonPort, $VitePort -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

  # 3. Launch (minimized, so windows land in the taskbar without stealing focus).
  #    Stagger so the daemon and Vite are serving before Electron probes them.
  #    The Electron job goes through a .bat because clearing ELECTRON_RUN_AS_NODE
  #    inline (set VAR= && ...) is unreliable in cmd; if it stays set, Electron
  #    boots in plain-Node mode and never opens a window.
  Write-Host "`nStarting Hive $(if ($DaemonOnly) { 'daemon' } else { 'dev stack' })..."
  Start-Process -FilePath cmd.exe -ArgumentList '/k', "title Hive Daemon && cd /d $repo && bun --watch packages/daemon/src/server/start.ts" -WindowStyle Minimized
  if (-not $DaemonOnly) {
    Start-Sleep -Seconds 2
    Start-Process -FilePath cmd.exe -ArgumentList '/k', "title Hive UI Vite && cd /d $repo\packages\ui && bun run dev" -WindowStyle Minimized
    Start-Sleep -Seconds 2
    $bat = "$env:TEMP\hive-shell-launch.bat"
    @"
title Hive Shell Electron
cd /d $repo\packages\shell
set ELECTRON_RUN_AS_NODE=
set HIVE_UI_MODE=dev
bun run start
"@ | Out-File -Encoding ASCII -FilePath $bat
    Start-Process -FilePath cmd.exe -ArgumentList '/k', $bat -WindowStyle Minimized
  }
}

# 4. Verify.
Write-Host "`nVerifying (up to ~30s for first boot)..."
$daemon = Wait-For 30 { (Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/ready" -UseBasicParsing -TimeoutSec 3).Content -match '"status"\s*:\s*"ok"' }

# Health-check the deploy-manager's kit surface (the agent stack is gone — ADR-0021).
$kitOk = $false
if ($daemon) {
  try {
    $token = (Get-Content "$env:USERPROFILE\.hive\.token" -Raw).Trim()
    $resp = Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/kit/catalog" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 3
    $kitOk = $resp.StatusCode -eq 200
  } catch { }
}

$vite = $false
$electronUp = $false
if (-not $DaemonOnly) {
  $vite = Wait-For 15 { (Invoke-WebRequest "http://127.0.0.1:$VitePort/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
  # Electron boots its window a few seconds slower than Vite serves, so poll.
  $electronUp = Wait-For 30 { [bool](Get-Process | Where-Object { $_.MainWindowTitle -like '*Hive*' -and $_.ProcessName -like 'electron*' }) }
}

# Electron gates PASS here (agent launcher — it can't see the window). The
# human launcher, dev.ts, treats Electron as informational.
$pass = $daemon -and $kitOk
if (-not $DaemonOnly) { $pass = $pass -and $vite -and $electronUp }

Write-Host "`n=== Hive $(if ($DaemonOnly) { 'daemon' } else { 'dev stack' }) ==="
Write-Host ("  daemon    :{0} /api/ready -> {1}" -f $DaemonPort, $(if ($daemon) { 'ok' } else { 'unreachable' }))
Write-Host ("  kit       /api/kit/catalog -> {0}" -f $(if ($kitOk) { 'ok' } else { 'unreachable' }))
if (-not $DaemonOnly) {
  Write-Host ("  vite      :{0} -> {1}" -f $VitePort, $(if ($vite) { 'ok' } else { 'unreachable' }))
  Write-Host ("  electron  {0}" -f $(if ($electronUp) { 'running (window visible)' } else { 'not detected' }))
}
Write-Host ("  STATUS: {0}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }))
if (-not $pass) { exit 1 }
