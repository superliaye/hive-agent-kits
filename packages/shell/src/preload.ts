// Electron preload — runs in an isolated context, exposes a narrow surface
// to the renderer through contextBridge. Two responsibilities:
//
//   1. Authenticated relative-path Daemon requests through sender-bound IPC.
//   2. `openExternal(url)` — opens an http/https URL in the user's default
//      browser via the main process's `shell.openExternal`. Used for the
//      OAuth login flow so the user's browser handles the Anthropic
//      consent screen rather than the in-app webview.

import { contextBridge, ipcRenderer } from "electron";

function readArg(prefix: string): string {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

const connectionKind = readArg("--hive-connection-kind=") === "external" ? "external" : "managed";
const displayName = decodeURIComponent(readArg("--hive-display-name="));
type ConnectionStatus = "connected" | "disconnected";
const initialConnectionStatus: ConnectionStatus =
  readArg("--hive-connection-status=") === "disconnected" ? "disconnected" : "connected";
const connection: {
  kind: "managed" | "external";
  displayName: string;
  status: ConnectionStatus;
} = {
  kind: connectionKind,
  displayName,
  status: initialConnectionStatus,
};

ipcRenderer.on("hive:connectionStatus", (_event, status: unknown) => {
  if (status !== "connected" && status !== "disconnected") return;
  connection.status = status;
  window.dispatchEvent(
    new CustomEvent("hive:connection-changed", {
      detail: { ...connection },
    }),
  );
});

contextBridge.exposeInMainWorld("__hive", {
  connection,
  getConnection: () => ({ ...connection }),
  daemon: {
    request: (
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ): Promise<{ status: number; statusText: string; body: string }> =>
      ipcRenderer.invoke("hive:daemonRequest", path, init),
  },
  /** "win32" | "darwin" | "linux" — renderer uses this to position the
   * window-controls reservation in the draggable top strip. */
  platform: process.platform,
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("hive:openExternal", url),
  /** Update Electron window chrome (title bar overlay + nativeTheme) to
   * match the active theme. Renderer calls this whenever theme resolves. */
  setChromeTheme: (payload: { mode: "light" | "dark"; bg: string; fg: string }): Promise<void> =>
    ipcRenderer.invoke("hive:setChromeTheme", payload),
  /** Read the OS accent color as `#rrggbb`, or null when unavailable. Backs
   * the "Use system accent" appearance toggle. */
  getSystemAccent: (): Promise<string | null> => ipcRenderer.invoke("hive:getSystemAccent"),
  /** Compatibility signal for older renderers. The main process now queries
   * durable deployment activity from the Daemon before shutdown. */
  setDeployInFlight: (inFlight: boolean): Promise<void> =>
    ipcRenderer.invoke("hive:setDeployInFlight", inFlight),
});
