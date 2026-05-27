// Electron main process. Probe-then-spawn the Bun daemon per ADR-0002.
//
// Two modes:
//   - Packaged (app.isPackaged) — spawn the bundled daemon binary from
//     <resources>/hive-daemon[.exe] and point it at <resources>/bundled.
//     Load the UI from <appPath>/ui-dist/index.html.
//   - Dev — spawn `bun run src/server/start.ts` against the repo source.
//     Load the UI from ui/dist (if built) or the Vite dev URL.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from "electron";
import { z } from "zod";

// Renderer→main IPC contracts. AGENTS.md requires Zod at external
// boundaries — the renderer process is its own untrusted context even
// when we wrote the code that runs in it.
const ChromeThemePayloadSchema = z
  .object({
    mode: z.enum(["light", "dark"]),
    bg: z.string().min(1).max(64),
    fg: z.string().min(1).max(64),
  })
  .strict();

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
    // Themed chrome: Windows + macOS get a custom title bar; the renderer
    // marks the top strip as -webkit-app-region: drag. Linux keeps its
    // native frame (window-manager-dependent; cleaner than rolling our
    // own controls). Menu bar autohides on Win/Linux (Alt reveals).
    autoHideMenuBar: true,
    titleBarStyle:
      process.platform === "darwin"
        ? "hiddenInset"
        : process.platform === "win32"
          ? "hidden"
          : "default",
    titleBarOverlay:
      process.platform === "win32"
        ? { color: "#0d1117", symbolColor: "#e6edf3", height: 32 }
        : undefined,
    backgroundColor: "#0d1117",
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

// Renderer → main bridge for `shell.openExternal`. The preload exposes this
// as `window.__hive.openExternal(url)`. Used by the OAuth login UI so the
// user's default browser handles the Anthropic consent screen instead of
// Electron's webview.
//
// Strict allowlist: only http(s) URLs. `shell.openExternal` can launch
// arbitrary URI handlers (file://, custom protocols, even mailto:) — a
// compromised renderer must not be able to trigger those.
// Renderer → main: update window chrome to match the active theme.
// Called on every theme resolution from the ThemeProvider bridge. Bad
// payloads are silently ignored (chrome just stays at the previous
// value — non-fatal). Zod-validated to keep the IPC contract honest.
ipcMain.handle("hive:setChromeTheme", (event, payload: unknown) => {
  const parsed = ChromeThemePayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  const { mode, bg, fg } = parsed.data;
  nativeTheme.themeSource = mode;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (process.platform === "win32") {
    try {
      win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 32 });
    } catch {
      // setTitleBarOverlay requires titleBarStyle:'hidden' at create time;
      // older windows from before this commit won't accept the call.
    }
  }
  try {
    win.setBackgroundColor(bg);
  } catch {
    // No-op
  }
});

ipcMain.handle("hive:openExternal", async (_event, url: unknown) => {
  if (typeof url !== "string") {
    throw new Error("openExternal: url must be a string");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("openExternal: invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`openExternal: refused protocol ${parsed.protocol}`);
  }
  await shell.openExternal(url);
});

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
