// Electron main process. Probe-then-spawn the Bun daemon per ADR-0002.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";

const DAEMON_URL = "http://127.0.0.1:3117";
const TOKEN_PATH = join(homedir(), ".hive", ".token");
// __dirname = shell/dist after compile; repo root is two levels up.
const REPO_ROOT = resolve(__dirname, "..", "..");
const UI_DEV_URL = process.env.HIVE_UI_DEV_URL ?? "http://127.0.0.1:5173";
const UI_DIST_INDEX = join(REPO_ROOT, "ui", "dist", "index.html");

let daemon: ChildProcess | null = null;
let spawnedByShell = false;

async function isDaemonReady(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/ready`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonReady()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon failed to become ready");
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonReady()) {
    return;
  }
  // Spawn bun in the repo root. In a packaged build this would be a bundled
  // daemon binary; for the slice we run from source.
  const cmd = process.platform === "win32" ? "bun.exe" : "bun";
  daemon = spawn(cmd, ["run", "src/server/start.ts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  spawnedByShell = true;
  daemon.on("exit", (code) => {
    console.log(`[shell] daemon exited (code=${code})`);
  });
  await waitForReady();
}

function readToken(): string {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`token file missing at ${TOKEN_PATH}`);
  }
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

async function createWindow(): Promise<void> {
  const token = readToken();
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Pass daemon coordinates through additional arguments so the preload
      // script can hand them to the renderer.
      additionalArguments: [`--hive-base=${DAEMON_URL}`, `--hive-token=${token}`],
    },
  });

  if (process.env.HIVE_UI_MODE === "dev" || process.env.NODE_ENV === "development") {
    await win.loadURL(UI_DEV_URL);
  } else if (existsSync(UI_DIST_INDEX)) {
    await win.loadFile(UI_DIST_INDEX);
  } else {
    // Fall back to dev URL if no production bundle has been built.
    await win.loadURL(UI_DEV_URL);
  }
}

app.whenReady().then(async () => {
  await ensureDaemon();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(console.error);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (daemon && spawnedByShell && !daemon.killed) {
    daemon.kill("SIGTERM");
  }
});
