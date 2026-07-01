# Windows dev launcher: prepare deps, tear down any prior stack FOR THIS
# INSTANCE, open the stack terminals + Electron window (minimized, so they don't
# steal focus), then verify health and print one STATUS block. Run it directly
# (not through bun) so Start-Process creates real windows even from an agent's
# PowerShell tool:
#
#   pwsh -NoProfile -File scripts\dev.ps1                 # full GUI stack (instance 0)
#   pwsh -NoProfile -File scripts\dev.ps1 -DaemonOnly     # daemon API only, no GUI
#   pwsh -NoProfile -File scripts\dev.ps1 -Instance 1     # a second, isolated stack
#   pwsh -NoProfile -File scripts\dev.ps1 -FixtureSources # full GUI stack with offline fixture Sources
#   pwsh -NoProfile -File scripts\dev.ps1 -Instance 1 -Stop  # tear down instance 1 (windows + ports), no relaunch
#
# -Instance N (default 0) shifts every port by N and gives the stack its own
# runtime root, so multiple agents can each run a full stack in parallel without
# colliding:
#       daemon 3117+N    vite 5173+N    electron CDP 9333+N
#       runtime root  ~/.hive  (N=0)  |  ~/.hive-N  (N>0)
# Attach the visual loop to this instance's REAL window on CDP 9333+N
# (scripts/screenshot.ts --cdp 9333+N, or agent-browser connect 9333+N).
# Teardown is scoped to the instance — relaunching instance 0 never disturbs a
# running instance 1. Different clones/agents must pick different -Instance.
#
# Windows open minimized to the taskbar; the Electron app window shows unfocused
# (see shell/src/main.ts) so a launch never pulls you out of what you're doing.
# The cross-platform `bun run dev:full` (scripts/dev.ts) is the equivalent for a
# human in a real terminal; this .ps1 exists because window creation from a
# bun-spawned child does not survive a non-interactive agent session.

param(
  # Launch only the daemon and verify its API; skip Vite + Electron. If a
  # healthy daemon is already running for this instance, reuse it instead of
  # restarting, so testing the API doesn't disturb an open GUI stack.
  [switch]$DaemonOnly,
  # Launch with checked-in offline fixture Sources under an isolated fixture
  # runtime root. Normal dev launches leave this disabled.
  [switch]$FixtureSources,
  # Instance number (default 0). Shifts all ports by this amount and isolates
  # the runtime root so parallel stacks never collide. Keep it small (0..99).
  [int]$Instance = 0,
  # Tear down THIS instance's stack (the titled cmd hosts + their bun/electron
  # children + the ports) and exit, without relaunching. The one-shot teardown a
  # human or an agent runs after a visual-verification pass, so the minimized
  # `cmd /k` host windows don't linger. Reuses the same teardown the relaunch
  # path runs, so there is one cleanup definition.
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($Instance -lt 0 -or $Instance -gt 99) { Write-Host "Instance must be 0..99 (got $Instance)"; exit 1 }
$DaemonPort = 3117 + $Instance
$VitePort = 5173 + $Instance
$CdpPort = 9333 + $Instance
$RuntimeRoot = if ($Instance -eq 0) {
  Join-Path $env:USERPROFILE $(if ($FixtureSources) { '.hive-fixtures' } else { '.hive' })
} else {
  Join-Path $env:USERPROFILE $(if ($FixtureSources) { ".hive-fixtures-$Instance" } else { ".hive-$Instance" })
}
$FixtureRegistryExisted = $FixtureSources -and (Test-Path (Join-Path $RuntimeRoot 'sources.json'))
$HomesRoot = Join-Path $RuntimeRoot 'homes'
$FixtureEnvLines = if ($FixtureSources) {
@"
set HIVE_DEV_FIXTURE_SOURCES=1
set HIVE_CLAUDE_HOME=$(Join-Path $HomesRoot '.claude')
set HIVE_CODEX_HOME=$(Join-Path $HomesRoot '.codex')
set HIVE_AGENTS_HOME=$(Join-Path $HomesRoot '.agents')
set HIVE_LEDGER_PATH=$(Join-Path $HomesRoot '.agent-kit\manifest.json')
"@.TrimEnd()
} else { '' }
# Per-instance launcher .bat files (one `set` per line — chaining `set VAR=val &&`
# inline in cmd captures the trailing space into the value, which silently
# corrupts a path like HIVE_RUNTIME_ROOT).
$daemonBatName = "hive-daemon-launch-$Instance.bat"
$batName = "hive-shell-launch-$Instance.bat"

# Tear down any stack FOR THIS INSTANCE only. Each instance's processes are
# identified by unique strings in their command lines: the daemon + Electron
# hosts launch via this instance's per-instance .bat files; Vite is inline and
# carries `--port <port>`. taskkill /T cascades each titled cmd host to its bun +
# electron children; the port sweep is the backstop that also reaps an Electron
# orphaned from an already-closed window (it still holds the CDP port until it
# exits). Called by BOTH the standalone -Stop path and the relaunch path, so the
# cleanup lives in one place.
function Stop-DevStack {
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match [regex]::Escape($daemonBatName) -or
        $_.CommandLine -match [regex]::Escape($batName) -or
        $_.CommandLine -match "--port $VitePort\b"
      )
    } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
  Get-NetTCPConnection -State Listen -LocalPort $DaemonPort, $VitePort, $CdpPort -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

# Standalone teardown: stop this instance and exit (no install, no relaunch).
if ($Stop) {
  Write-Host "Stopping Hive dev stack (instance $Instance)..."
  Stop-DevStack
  Start-Sleep -Milliseconds 600
  $busy = Get-NetTCPConnection -State Listen -LocalPort $DaemonPort, $VitePort, $CdpPort -ErrorAction SilentlyContinue
  if ($busy) {
    Write-Host "STATUS: PARTIAL - ports still listening: $(( $busy | ForEach-Object { $_.LocalPort } | Sort-Object -Unique ) -join ', ')"
    exit 1
  }
  Write-Host "STATUS: STOPPED - daemon :$DaemonPort / vite :$VitePort / cdp :$CdpPort freed; windows closed."
  exit 0
}

function Wait-For($timeoutSec, $check) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { if (& $check) { return $true } } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Daemon-only: reuse a healthy normal daemon if one is already up for this
# instance. Fixture mode bypasses reuse so it cannot attach to a normal daemon.
$reuse = $false
if ($DaemonOnly -and -not $FixtureSources) {
  try { $reuse = (Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/ready" -UseBasicParsing -TimeoutSec 2).Content -match '"status"\s*:\s*"ok"' } catch { $reuse = $false }
  if ($reuse) { Write-Host "Daemon already healthy on :$DaemonPort (instance $Instance) - reusing (no restart)." }
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

  # 2. Tear down any prior stack FOR THIS INSTANCE only (same cleanup the
  #    standalone -Stop path runs).
  Stop-DevStack

  # 3. Launch (minimized, so windows land in the taskbar without stealing focus).
  #    Stagger so the daemon and Vite are serving before Electron probes them.
  #    Per-instance env (HIVE_PORT / HIVE_RUNTIME_ROOT / HIVE_UI_DEV_URL /
  #    HIVE_CDP_PORT) goes through a .bat (one `set` per line) so a parallel
  #    instance stays fully separate AND no value picks up the trailing space
  #    that inline `set VAR=val && ...` chaining would capture. Electron also
  #    needs the .bat to *clear* ELECTRON_RUN_AS_NODE (if it stays set, Electron
  #    boots in plain-Node mode and never opens a window). Vite needs no env, so
  #    it stays inline.
  Write-Host "`nStarting Hive $(if ($DaemonOnly) { 'daemon' } else { 'dev stack' })$(if ($FixtureSources) { ' with fixture Sources' } else { '' }) (instance $Instance)..."
  $daemonBat = Join-Path $env:TEMP $daemonBatName
  @"
title Hive Daemon [i$Instance]
cd /d $repo
set HIVE_PORT=$DaemonPort
set HIVE_RUNTIME_ROOT=$RuntimeRoot
$FixtureEnvLines
bun --watch packages/daemon/src/server/start.ts
"@ | Out-File -Encoding ASCII -FilePath $daemonBat
  Start-Process -FilePath cmd.exe -ArgumentList '/k', $daemonBat -WindowStyle Minimized
  if (-not $DaemonOnly) {
    Start-Sleep -Seconds 2
    Start-Process -FilePath cmd.exe -ArgumentList '/k', "title Hive UI Vite [i$Instance] && cd /d $repo\packages\ui && bun run dev --port $VitePort" -WindowStyle Minimized
    Start-Sleep -Seconds 2
    $bat = Join-Path $env:TEMP $batName
    @"
title Hive Shell Electron [i$Instance]
cd /d $repo\packages\shell
set ELECTRON_RUN_AS_NODE=
set HIVE_UI_MODE=dev
set HIVE_PORT=$DaemonPort
set HIVE_RUNTIME_ROOT=$RuntimeRoot
$FixtureEnvLines
set HIVE_UI_DEV_URL=http://127.0.0.1:$VitePort
set HIVE_CDP_PORT=$CdpPort
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
$fixturesOk = -not $FixtureSources
if ($daemon) {
  try {
    $token = (Get-Content (Join-Path $RuntimeRoot '.token') -Raw).Trim()
    $resp = Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/kit/catalog" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 3
    $kitOk = $resp.StatusCode -eq 200
    if ($FixtureSources) {
      $fixturesOk = Wait-For 15 {
        $sources = Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/sources" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 3 | Select-Object -ExpandProperty Content | ConvertFrom-Json
        $state = Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/kit/state" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 3 | Select-Object -ExpandProperty Content | ConvertFrom-Json
        $catalog = Invoke-WebRequest "http://127.0.0.1:$DaemonPort/api/kit/catalog" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 3 | Select-Object -ExpandProperty Content | ConvertFrom-Json
        $fixtureIds = @($sources | Where-Object { $_.id -like 'fixture-*' } | ForEach-Object { $_.id })
        $freshSeedPresent = $FixtureRegistryExisted -or (
          $fixtureIds -contains 'fixture-alpha' -and
          $fixtureIds -contains 'fixture-beta' -and
          $fixtureIds -contains 'fixture-gamma'
        )
        $activeFixtureIds = @($sources | Where-Object { $_.active -and $_.id -like 'fixture-*' } | ForEach-Object { $_.id })
        if ($activeFixtureIds.Count -eq 0) { return ($freshSeedPresent -and $FixtureRegistryExisted) }
        foreach ($id in $activeFixtureIds) {
          $sync = @($state.sync | Where-Object { $_.sourceId -eq $id } | Select-Object -First 1)
          $catalogEntry = @($catalog.entries | Where-Object { @($_.sourceIds) -contains $id } | Select-Object -First 1)
          if (-not $sync -or $sync.state -ne 'local' -or -not $catalogEntry) { return $false }
        }
        return $freshSeedPresent
      }
    }
  } catch { }
}

$vite = $false
$cdpUp = $false
if (-not $DaemonOnly) {
  $vite = Wait-For 15 { (Invoke-WebRequest "http://127.0.0.1:$VitePort/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
  # The Electron window exposes the dev CDP port once its renderer is up. Probe
  # /json/version (not just the window title): it proves the visual loop can
  # actually attach, and is instance-scoped (each window owns a distinct port).
  $cdpUp = Wait-For 30 { (Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
}

# Electron gates PASS here via its CDP port (agent launcher — it can't see the
# window). The human launcher, dev.ts, treats Electron as informational.
$pass = $daemon -and $kitOk -and $fixturesOk
if (-not $DaemonOnly) { $pass = $pass -and $vite -and $cdpUp }

Write-Host "`n=== Hive $(if ($DaemonOnly) { 'daemon' } else { 'dev stack' }) (instance $Instance) ==="
Write-Host ("  daemon    :{0} /api/ready -> {1}" -f $DaemonPort, $(if ($daemon) { 'ok' } else { 'unreachable' }))
Write-Host ("  kit       /api/kit/catalog -> {0}" -f $(if ($kitOk) { 'ok' } else { 'unreachable' }))
if (-not $DaemonOnly) {
  Write-Host ("  vite      :{0} -> {1}" -f $VitePort, $(if ($vite) { 'ok' } else { 'unreachable' }))
  Write-Host ("  electron  CDP :{0} -> {1}" -f $CdpPort, $(if ($cdpUp) { 'ok (visual loop ready)' } else { 'unreachable' }))
}
if ($FixtureSources) {
  Write-Host ("  fixtures  {0}" -f $(if ($fixturesOk) { 'present' } else { 'missing' }))
}
Write-Host ("  runtime   {0}" -f $RuntimeRoot)
Write-Host ("  STATUS: {0}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }))
if (-not $pass) { exit 1 }
