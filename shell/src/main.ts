// Electron main process. Probe-then-spawn the Bun daemon per ADR-0002.
//
// Two modes:
//   - Packaged (app.isPackaged) — spawn the bundled daemon binary from
//     <resources>/hive-daemon[.exe] and point it at <resources>/bundled.
//     Load the UI from <appPath>/ui-dist/index.html.
//   - Dev — spawn `bun run src/server/start.ts` against the repo source.
//     Load the UI from ui/dist (if built) or the Vite dev URL.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";

const isWin = process.platform === "win32";
const PORT = process.env.HIVE_PORT ? Number(process.env.HIVE_PORT) : 3117;
const DAEMON_URL = `http://127.0.0.1:${PORT}`;
const RUNTIME_ROOT = process.env.HIVE_RUNTIME_ROOT ?? join(homedir(), ".hive");
const TOKEN_PATH = join(RUNTIME_ROOT, ".token");

// __dirname = shell/dist after compile; repo root is two levels up.
// Only meaningful in dev mode — packaged apps don't have a repo root.
const REPO_ROOT = resolve(__dirname, "..", "..");
const UI_DEV_URL = process.env.HIVE_UI_DEV_URL ?? "http://127.0.0.1:5173";

// Packaged-mode resource paths. process.resourcesPath is where
// electron-builder's `extraResources` writes; app.getAppPath() is the asar.
const PACKAGED_DAEMON = app.isPackaged
  ? join(process.resourcesPath, isWin ? "hive-daemon.exe" : "hive-daemon")
  : null;
const PACKAGED_BUNDLED = app.isPackaged ? join(process.resourcesPath, "bundled") : null;
const UI_DIST_INDEX = app.isPackaged
  ? join(app.getAppPath(), "ui-dist", "index.html")
  : join(REPO_ROOT, "ui", "dist", "index.html");

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
  if (PACKAGED_DAEMON) {
    // Packaged: spawn the bundled binary, point it at the bundled resource dir.
    daemon = spawn(PACKAGED_DAEMON, [], {
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      env: { ...process.env, HIVE_BUNDLED_ROOT: PACKAGED_BUNDLED ?? "" },
    });
  } else {
    // Dev: bun against the source tree. No shell:true so SIGKILL reaches
    // bun.exe directly and Electron quit completes promptly.
    const cmd = isWin ? "bun.exe" : "bun";
    daemon = spawn(cmd, ["run", "src/server/start.ts"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
  }
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

// Block Electron's exit until the daemon child has actually exited. Without
// this, on Windows the orphan bun.exe keeps `audit.db` open and binds the
// port — e2e tests then race against cleanup.
let quitting = false;
app.on("before-quit", (event) => {
  if (!daemon || !spawnedByShell || daemon.killed || quitting) return;
  event.preventDefault();
  quitting = true;
  const sig: NodeJS.Signals = isWin ? "SIGKILL" : "SIGTERM";
  daemon.once("exit", () => {
    daemon = null;
    app.quit();
  });
  daemon.kill(sig);
  // Force-exit if the daemon hasn't responded in 3s.
  setTimeout(() => {
    if (daemon && !daemon.killed) {
      try {
        daemon.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    if (quitting) app.exit(0);
  }, 3_000).unref();
});
