// Dev orchestrator: opens three visible terminals, one per stack piece.
// Each terminal owns its piece's lifecycle — close the window to stop it.
// No background processes, no hidden state.
//
// Windows: cmd.exe windows opened via `start "title" cmd /k …`
// macOS:   Terminal.app via osascript
// Linux:   x-terminal-emulator / gnome-terminal / xterm (first one found)

import { spawn, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";

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
  // instead of ui/dist/.
  {
    title: "Hive Shell (Electron)",
    cmd: "bun run start",
    cwd: "shell",
    env: { HIVE_UI_MODE: "dev" },
  },
];

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

function envPrefix(env: Job["env"]): string {
  if (!env || Object.keys(env).length === 0) return "";
  if (isWin) {
    return `${Object.entries(env)
      .map(([k, v]) => `set ${k}=${v}`)
      .join(" && ")} && `;
  }
  return `${Object.entries(env)
    .map(([k, v]) => `export ${k}=${v}`)
    .join(" && ")} && `;
}

function spawnTerminal(job: Job): void {
  const fullCwd = job.cwd ? resolve(REPO_ROOT, job.cwd) : REPO_ROOT;
  const opts: SpawnOptions = { detached: true, stdio: "ignore" };

  if (isWin) {
    // /k keeps the cmd window open after the command exits — closing the
    // window then requires a deliberate click, so "close to stop" is intuitive.
    const inner = `${envPrefix(job.env)}cd /d "${fullCwd}" && ${job.cmd}`;
    spawn("cmd", ["/c", "start", `"${job.title}"`, "cmd", "/k", inner], opts);
    return;
  }
  if (isMac) {
    const inner = `${envPrefix(job.env)}cd '${fullCwd}' && ${job.cmd}`;
    const script = `tell application "Terminal" to do script "${inner.replace(/"/g, '\\"')}"`;
    spawn("osascript", ["-e", script], opts);
    return;
  }
  // Linux: try common terminal emulators in order.
  const inner = `${envPrefix(job.env)}cd '${fullCwd}' && ${job.cmd}; exec bash`;
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-T", job.title, "-e", "bash", "-c", inner]],
    ["gnome-terminal", ["--title", job.title, "--", "bash", "-c", inner]],
    ["xterm", ["-T", job.title, "-e", "bash", "-c", inner]],
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
