// Electron preload — runs in an isolated context, exposes the daemon URL
// and bearer token to the renderer through contextBridge. Nothing else.

import { contextBridge } from "electron";

function readArg(prefix: string): string {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

const baseUrl = readArg("--hive-base=");
const token = readArg("--hive-token=");

contextBridge.exposeInMainWorld("__hive", { baseUrl, token });
