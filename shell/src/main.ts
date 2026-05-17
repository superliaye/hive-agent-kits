// Electron main process. Probe-then-spawn the Bun daemon per ADR-0002.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";

const PORT = process.env.HIVE_PORT ? Number(process.env.HIVE_PORT) : 3117;
const DAEMON_URL = `http://127.0.0.1:${PORT}`;
const RUNTIME_ROOT = process.env.HIVE_RUNTIME_ROOT ?? join(homedir(), ".hive");
const TOKEN_PATH = join(RUNTIME_ROOT, ".token");
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
  if (await isDaemonReady()) return;
  // Spawn bun directly (no shell wrapper). Without shell:true on Windows,
  // SIGKILL reaches bun.exe directly so teardown completes promptly.
  const cmd = process.platform === "win32" ? "bun.exe" : "bun";
  daemon = spawn(cmd, ["run", "src/server/start.ts"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  spawnedByShell = true;
  daemon.on("error", (err) => {
    console.error("[shell] daemon spawn error:", err);
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
      additionalArguments: [`--hive-base=${DAEMON_URL}`, `--hive-token=${token}`],
    },
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[shell] did-fail-load: ${code} ${desc} ${url}`);
  });
  if (process.env.HIVE_UI_MODE === "dev" || process.env.NODE_ENV === "development") {
    await win.loadURL(UI_DEV_URL);
  } else if (existsSync(UI_DIST_INDEX)) {
    await win.loadFile(UI_DIST_INDEX);
  } else {
    await win.loadURL(UI_DEV_URL);
  }
}

app.whenReady().then(async () => {
  try {
    await ensureDaemon();
    await createWindow();
  } catch (err) {
    console.error("[shell] startup failed:", err);
    app.exit(1);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => console.error("[shell] activate failed:", err));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (daemon && spawnedByShell && !daemon.killed) {
    // SIGKILL on Windows because SIGTERM is not reliably delivered to a
    // detached Bun subprocess; SIGTERM elsewhere for clean shutdown.
    daemon.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  }
});
