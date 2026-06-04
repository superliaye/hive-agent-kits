// Dev orchestrator: prepares deps, tears down any prior stack, opens one
// terminal per stack piece (minimized on Windows so they don't steal focus),
// then verifies health and prints a STATUS block. Each terminal owns its
// piece's lifecycle — close the window to stop it.
//
//   bun run dev:full                  full GUI stack (default)
//   bun run dev:full -- --daemon-only  daemon API only, no Vite/Electron
//
// Windows: cmd.exe windows opened via `start "title" /min cmd /k …`
// macOS:   Terminal.app via osascript
// Linux:   x-terminal-emulator / gnome-terminal / xterm (first one found)

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Job = {
  title: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
};

const REPO_ROOT = resolve(import.meta.dir, "..");
const DAEMON_PORT = 3117;
const VITE_PORT = 5173;
const daemonOnly = process.argv.includes("--daemon-only");

const jobs: Job[] = [
  {
    title: "Hive Daemon",
    cmd: "bun --watch src/server/start.ts",
  },
  {
    title: "Hive UI (Vite)",
    cmd: "bun run dev",
    cwd: "ui",
  },
  // Shell runs last so daemon + Vite are already serving by the time Electron
  // probes them. HIVE_UI_MODE=dev tells main.ts to load from the Vite URL
  // instead of ui/dist/. ELECTRON_RUN_AS_NODE is unset here because if it's
  // set globally in the user's env (Microsoft default, see e2e harness),
  // Electron starts in plain-Node mode and never creates a window.
  {
    title: "Hive Shell (Electron)",
    cmd: "bun run start",
    cwd: "shell",
    env: { HIVE_UI_MODE: "dev", ELECTRON_RUN_AS_NODE: "" },
  },
];

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// Staging dir for the per-job launcher scripts. Writing each command to its
// own file (`.bat` on Windows, `.sh` elsewhere) sidesteps quoting and `&&`
// pitfalls — most importantly, `set VAR=` (clear an env var) is unreliable
// when chained with `&&` on Windows cmd.
const stageDir = mkdtempSync(join(tmpdir(), "hive-dev-"));

function writeBat(job: Job, fullCwd: string): string {
  const path = join(stageDir, `${job.title.replace(/\W+/g, "-")}.bat`);
  const envLines = Object.entries(job.env ?? {})
    .map(([k, v]) => `set ${k}=${v}`)
    .join("\r\n");
  const body = [`title ${job.title}`, `cd /d ${fullCwd}`, envLines, job.cmd]
    .filter((line) => line.length > 0)
    .join("\r\n");
  writeFileSync(path, `${body}\r\n`);
  return path;
}

function writeSh(job: Job, fullCwd: string): string {
  const path = join(stageDir, `${job.title.replace(/\W+/g, "-")}.sh`);
  const envLines = Object.entries(job.env ?? {})
    .map(([k, v]) => `export ${k}=${v}`)
    .join("\n");
  const body = ["#!/usr/bin/env bash", `cd '${fullCwd}'`, envLines, job.cmd]
    .filter((line) => line.length > 0)
    .join("\n");
  writeFileSync(path, `${body}\nexec bash\n`, { mode: 0o755 });
  return path;
}

function spawnTerminal(job: Job): void {
  const fullCwd = job.cwd ? resolve(REPO_ROOT, job.cwd) : REPO_ROOT;
  const opts: SpawnOptions = { detached: true, stdio: "ignore" };

  if (isWin) {
    // Each job's command list is written to a per-job .bat so cmd /k can run
    // it as a script — no quoting/chaining gotchas. /k keeps the window open
    // after the script exits.
    const bat = writeBat(job, fullCwd);
    // /min: land in the taskbar without stealing focus.
    spawn("cmd", ["/c", "start", `"${job.title}"`, "/min", "cmd", "/k", bat], opts);
    return;
  }
  if (isMac) {
    const sh = writeSh(job, fullCwd);
    const script = `tell application "Terminal" to do script "${sh}"`;
    spawn("osascript", ["-e", script], opts);
    return;
  }
  const sh = writeSh(job, fullCwd);
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-T", job.title, "-e", "bash", sh]],
    ["gnome-terminal", ["--title", job.title, "--", "bash", sh]],
    ["xterm", ["-T", job.title, "-e", "bash", sh]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      spawn(cmd, args, opts);
      return;
    } catch {
      // try next
    }
  }
  console.error(`No terminal emulator found. Run manually in three terminals:\n  ${job.cmd}`);
}

// Install deps before launching. `bun install` is near-instant when the
// lockfile is already satisfied, so this is cheap on a warm repo and the only
// thing that makes a freshly cloned or pulled (dependency-drifted) repo
// actually boot — without it the daemon and Vite start but silently fail to
// bind their ports. Daemon-only needs the root package alone.
function installAll(): void {
  const targets: Array<[string, string]> = [["root", REPO_ROOT]];
  if (!daemonOnly) {
    targets.push(["ui", resolve(REPO_ROOT, "ui")], ["shell", resolve(REPO_ROOT, "shell")]);
  }
  for (const [label, dir] of targets) {
    console.log(`→ bun install (${label})`);
    const r = spawnSync("bun", ["install"], { cwd: dir, stdio: "inherit", shell: isWin });
    if (r.status !== 0) {
      console.error(`bun install failed in ${label} (exit ${r.status})`);
      process.exit(1);
    }
  }
}

// Fully tear down any prior Hive stack before relaunching, so repeated starts
// restart cleanly instead of piling up orphaned windows. Just freeing the
// ports would leave the empty cmd /k windows and the Electron behind.
function stopPriorStack(): void {
  if (isWin) {
    // Kill the titled cmd host windows (taskkill /T cascades to their bun +
    // Electron children), sweep any Electron orphaned from an already-closed
    // window (scoped to this repo's binary so other Electron apps are spared),
    // then clear the ports as a backstop.
    const electronDir = resolve(REPO_ROOT, "shell", "node_modules");
    const cmd = [
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'hive-dev-|hive-shell-launch\\.bat' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }`,
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${electronDir}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      `Get-NetTCPConnection -State Listen -LocalPort ${DAEMON_PORT},${VITE_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    ].join("; ");
    spawnSync("powershell", ["-NoProfile", "-Command", cmd], { stdio: "ignore" });
    return;
  }
  // mac/linux: a launcher can't reliably close terminal windows, but it can
  // free the ports by killing whatever bun is bound to them.
  for (const port of [DAEMON_PORT, VITE_PORT]) {
    const found = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    for (const pid of (found.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      spawnSync("kill", ["-9", pid], { stdio: "ignore" });
    }
  }
}

async function waitFor(timeoutMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // not up yet — retry until the deadline
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function daemonHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/ready`);
    return res.ok && ((await res.json()) as { status?: string }).status === "ok";
  } catch {
    return false;
  }
}

function electronStatus(): "running" | "not detected" | "unknown" {
  try {
    if (isWin) {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/NH"], {
        encoding: "utf8",
      });
      return (r.stdout ?? "").toLowerCase().includes("electron.exe") ? "running" : "not detected";
    }
    const r = spawnSync("pgrep", ["-x", isMac ? "Electron" : "electron"], { encoding: "utf8" });
    return (r.stdout ?? "").trim().length > 0 ? "running" : "not detected";
  } catch {
    return "unknown";
  }
}

type Health = {
  daemon: boolean;
  vite: boolean;
  agents: string[];
  electron: "running" | "not detected" | "unknown";
};

async function verify(): Promise<Health> {
  const daemon = await waitFor(30_000, async () => {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/ready`);
    return res.ok && ((await res.json()) as { status?: string }).status === "ok";
  });

  const vite = daemonOnly
    ? false
    : await waitFor(15_000, async () => (await fetch(`http://127.0.0.1:${VITE_PORT}/`)).ok);

  let agents: string[] = [];
  if (daemon) {
    try {
      const token = readFileSync(join(homedir(), ".hive", ".token"), "utf8").trim();
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) agents = ((await res.json()) as Array<{ agentId: string }>).map((a) => a.agentId);
    } catch {
      // leave agents empty — reported as a failure below
    }
  }

  return { daemon, vite, agents, electron: daemonOnly ? "unknown" : electronStatus() };
}

function printStatus(h: Health): void {
  // Electron is informational here (this is the human launcher — you can see
  // the window). The agent launcher, dev.ps1, gates PASS on the window instead.
  const pass = daemonOnly
    ? h.daemon && h.agents.length > 0
    : h.daemon && h.vite && h.agents.length > 0;
  console.log(`\n=== Hive ${daemonOnly ? "daemon" : "dev stack"} ===`);
  console.log(`  daemon    :${DAEMON_PORT} /api/ready → ${h.daemon ? "ok" : "unreachable"}`);
  console.log(`  agents    ${h.agents.length ? h.agents.join(", ") : "(none)"}`);
  if (!daemonOnly) {
    console.log(`  vite      :${VITE_PORT} → ${h.vite ? "ok" : "unreachable"}`);
    console.log(
      `  electron  ${h.electron}${h.electron === "running" ? " (window should be visible)" : ""}`,
    );
  }
  console.log(`  STATUS: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

// Daemon-only: reuse a healthy daemon if one is already up, so testing the API
// doesn't restart (and disturb) a running GUI stack.
const reuse = daemonOnly && (await daemonHealthy());
if (reuse) {
  console.log(`Daemon already healthy on :${DAEMON_PORT} — reusing (no restart).`);
} else {
  console.log(`Preparing Hive ${daemonOnly ? "daemon" : "dev stack"}...\n`);
  installAll();
  stopPriorStack();

  const activeJobs = daemonOnly ? jobs.slice(0, 1) : jobs;
  console.log(`\nStarting Hive ${daemonOnly ? "daemon" : "dev stack"}...\n`);
  for (const [i, job] of activeJobs.entries()) {
    const where = job.cwd ? ` (in ${job.cwd}/)` : "";
    console.log(`  ${i + 1}. ${job.title}: ${job.cmd}${where}`);
    spawnTerminal(job);
    // Stagger so the daemon and Vite are up before Electron probes them.
    if (i < activeJobs.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  console.log("\nClose a window to stop that piece. Daemon writes to ~/.hive/.");
  console.log(`(Launcher scripts staged at ${stageDir})`);
}

console.log("\nVerifying (up to ~30s for first boot)...");
printStatus(await verify());
