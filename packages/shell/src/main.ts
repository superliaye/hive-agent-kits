// Electron main process. Probe-then-spawn the Bun daemon per ADR-0002.
//
// Two modes:
//   - Packaged (app.isPackaged) — spawn the bundled daemon binary from
//     <resources>/hive-daemon[.exe] (it syncs the Kit at runtime — no bundled
//     resource). Load the UI from <appPath>/ui-dist/index.html.
//   - Dev — spawn `bun run src/server/start.ts` against the repo source.
//     Load the UI from ui/dist (if built) or the Vite dev URL.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import { z } from "zod";
import { hasDaemonToDrain, shouldConfirmClose } from "./close-guard";

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

// No renderer payload to validate here — instead we validate the handler's
// *output* shape so a normalization regression surfaces in dev rather than as
// a malformed CSS color downstream in the renderer.
const SystemAccentResponseSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .nullable();

const isWin = process.platform === "win32";
const PORT = process.env.HIVE_PORT ? Number(process.env.HIVE_PORT) : 3117;
const DAEMON_URL = `http://127.0.0.1:${PORT}`;
const RUNTIME_ROOT = process.env.HIVE_RUNTIME_ROOT ?? join(homedir(), ".hive");
const TOKEN_PATH = join(RUNTIME_ROOT, ".token");

// __dirname = shell/dist after compile; repo root is two levels up.
// Only meaningful in dev mode — packaged apps don't have a repo root.
const REPO_ROOT = resolve(__dirname, "..", "..");
const UI_DEV_URL = process.env.HIVE_UI_DEV_URL ?? "http://127.0.0.1:5173";

// Dev only — expose Chrome DevTools Protocol so the visual loop can attach to
// the real window (Playwright connectOverCDP, or `agent-browser connect`).
// Default port 9333; HIVE_CDP_PORT lets parallel dev instances each open a
// distinct port (dev.ps1/dev.ts derive it per -Instance, alongside HIVE_PORT
// and the Vite URL, so isolated stacks never collide). Gated on !app.isPackaged
// so the port can never open in a shipped build, where the renderer holds the
// daemon bearer token. Must run before app.whenReady().
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.HIVE_CDP_PORT ?? "9333");
  // Anti-occlusion / anti-backgrounding. The dev window is visible-but-unfocused
  // (show:false → showInactive()), and Windows native occlusion tracking suspends
  // the window's compositor — so a CDP `page.screenshot()` reads an empty surface
  // and writes a black PNG. These keep the off-focus window painting so the visual
  // loop gets a real frame. Dev-only; shipped builds never weaken occlusion.
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
}

// Packaged-mode resource paths. process.resourcesPath is where
// electron-builder's `extraResources` writes; app.getAppPath() is the asar.
const PACKAGED_DAEMON = app.isPackaged
  ? join(process.resourcesPath, isWin ? "hive-daemon.exe" : "hive-daemon")
  : null;
const UI_DIST_INDEX = app.isPackaged
  ? join(app.getAppPath(), "ui-dist", "index.html")
  : join(REPO_ROOT, "ui", "dist", "index.html");

let daemon: ChildProcess | null = null;
let spawnedByShell = false;
// Feature 3: set by the renderer over IPC while a Kit deploy mutation is pending.
// before-quit consults it to confirm before SIGKILLing the daemon mid-write.
let deployInFlight = false;

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
    // Packaged: spawn the bundled daemon binary. HIVE_PACKAGED=1 is the single
    // authoritative production signal the daemon reads to deploy to the real CLI
    // homes (the daemon is a separate process, so app.isPackaged is invisible to
    // it). Dev launchers never set it, so a dev / hand-run daemon defaults to the
    // per-instance sandbox (the fail-safe default).
    daemon = spawn(PACKAGED_DAEMON, [], {
      env: { ...process.env, HIVE_PACKAGED: "1" },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
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

// In dev, Vite may not be serving yet when the window loads (the launchers
// stagger only ~1-2s before Electron). A failed loadURL would reject and exit
// the app; retry until Vite responds, letting the final attempt throw so a
// genuine failure is still surfaced.
async function loadDevUrl(win: BrowserWindow, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts - 1; i++) {
    try {
      await win.loadURL(UI_DEV_URL);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await win.loadURL(UI_DEV_URL);
}

async function createWindow(): Promise<void> {
  const token = readToken();
  const devMode = process.env.HIVE_UI_MODE === "dev" || process.env.NODE_ENV === "development";
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
    // Start hidden and show explicitly after load (below): avoids an empty
    // flash and, in dev, lets us show without stealing focus.
    show: false,
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
  if (devMode) {
    await loadDevUrl(win);
  } else if (existsSync(UI_DIST_INDEX)) {
    await win.loadFile(UI_DIST_INDEX);
  } else {
    await loadDevUrl(win);
  }
  // Dev launches shouldn't pull focus from whatever you're working on;
  // a production double-click should focus normally.
  if (devMode) win.showInactive();
  else win.show();
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

// Renderer → main: read the OS accent color for the "Use system accent"
// appearance toggle. getAccentColor() returns 8-hex RGBA without '#' on
// Win/macOS, "" when unavailable, and can throw on Linux — normalize to
// #rrggbb (drop the alpha) or null.
ipcMain.handle("hive:getSystemAccent", (): string | null => {
  let normalized: string | null;
  try {
    const raw = systemPreferences.getAccentColor();
    normalized = raw && raw.length >= 6 ? `#${raw.slice(0, 6)}` : null;
  } catch {
    normalized = null;
  }
  const parsed = SystemAccentResponseSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
});

// Renderer → main: the Kit deploy mutation toggles its in-flight state. A boolean
// payload only; anything else is ignored (the flag stays at its prior value).
ipcMain.handle("hive:setDeployInFlight", (_event, value: unknown) => {
  if (typeof value === "boolean") deployInFlight = value;
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
// Set once the user picks "Close anyway" so the confirm isn't re-shown on the
// fall-through (and on any subsequent before-quit pass) this quit cycle.
let closeConfirmed = false;
app.on("before-quit", (event) => {
  // Confirm BEFORE the drain when a deploy is in flight. Cancel keeps the app
  // open (no drain); "Close anyway" records the choice and falls through to the
  // existing daemon-drain sequencing below — no second preventDefault.
  if (shouldConfirmClose(deployInFlight, closeConfirmed)) {
    event.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Cancel", "Close anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Deploy in progress",
      message: "A capability deploy is still in progress.",
      detail: "Closing now will interrupt it and may leave a partial deploy on disk.",
    });
    if (choice === 0) return; // Cancel — stay open, do NOT drain.
    closeConfirmed = true;
    // We already preventDefaulted to show the dialog, so the quit is cancelled.
    // If there is no shell-spawned daemon to drain (the dev path spawns the
    // daemon separately, so daemon===null/spawnedByShell===false here), the drain
    // block below would early-return and the app would hang open. Re-issue the
    // quit ourselves; the next before-quit pass has closeConfirmed set, so it
    // skips the dialog and either drains or quits cleanly.
    if (
      !hasDaemonToDrain({
        hasDaemon: daemon !== null,
        spawnedByShell,
        daemonKilled: daemon?.killed ?? true,
      })
    ) {
      app.quit();
      return;
    }
    // Otherwise fall through to the drain sequencing below in this same pass.
  }
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
