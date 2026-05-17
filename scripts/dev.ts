// Dev orchestrator: opens three visible terminals, one per stack piece.
// Each terminal owns its piece's lifecycle — close the window to stop it.
// No background processes, no hidden state.
//
// Windows: cmd.exe windows opened via `start "title" cmd /k …`
// macOS:   Terminal.app via osascript
// Linux:   x-terminal-emulator / gnome-terminal / xterm (first one found)

import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Job = {
  title: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
};

const REPO_ROOT = resolve(import.meta.dir, "..");

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
    spawn("cmd", ["/c", "start", `"${job.title}"`, "cmd", "/k", bat], opts);
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
  console.error(
    `No terminal emulator found. Run manually in three terminals:\n  ${job.cmd}`,
  );
}

console.log("Starting Hive dev stack — three windows will open:\n");
for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i]!;
  const where = job.cwd ? ` (in ${job.cwd}/)` : "";
  console.log(`  ${i + 1}. ${job.title}: ${job.cmd}${where}`);
  spawnTerminal(job);
  // Stagger so the daemon and Vite are up before Electron probes them.
  if (i < jobs.length - 1) {
    await new Promise((r) => setTimeout(r, 1200));
  }
}

console.log("\nClose a window to stop that piece. Daemon writes to ~/.hive/.");
console.log("Token: cat ~/.hive/.token (Electron reads it automatically)");
console.log(`(Launcher scripts staged at ${stageDir})`);
