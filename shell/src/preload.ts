// Electron preload — runs in an isolated context, exposes a narrow surface
// to the renderer through contextBridge. Two responsibilities:
//
//   1. Daemon URL + bearer token (passed in via `additionalArguments`).
//   2. `openExternal(url)` — opens an http/https URL in the user's default
//      browser via the main process's `shell.openExternal`. Used for the
//      OAuth login flow so the user's browser handles the Anthropic
//      consent screen rather than the in-app webview.

import { contextBridge, ipcRenderer } from "electron";

function readArg(prefix: string): string {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

const baseUrl = readArg("--hive-base=");
const token = readArg("--hive-token=");

contextBridge.exposeInMainWorld("__hive", {
  baseUrl,
  token,
  /** "win32" | "darwin" | "linux" — renderer uses this to position the
   * window-controls reservation in the draggable top strip. */
  platform: process.platform,
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("hive:openExternal", url),
  /** Update Electron window chrome (title bar overlay + nativeTheme) to
   * match the active theme. Renderer calls this whenever theme resolves. */
  setChromeTheme: (payload: { mode: "light" | "dark"; bg: string; fg: string }): Promise<void> =>
    ipcRenderer.invoke("hive:setChromeTheme", payload),
});
