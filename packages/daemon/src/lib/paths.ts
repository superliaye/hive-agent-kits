// Path resolution for Hive's runtime storage.
//
// The RUNTIME root lives in OS app-storage (~/.hive/ today; future: Electron's
// app.getPath('userData')). Mutable per install. Env-overridable for tests via
// HIVE_RUNTIME_ROOT.

import { homedir } from "node:os";
import { join } from "node:path";

export function runtimeRoot(): string {
  if (process.env.HIVE_RUNTIME_ROOT) return process.env.HIVE_RUNTIME_ROOT;
  return join(homedir(), ".hive");
}

// Files that live in the runtime tier.
export const files = {
  config: () => join(runtimeRoot(), "config.yaml"),
  token: () => join(runtimeRoot(), ".token"),
  runtimeId: () => join(runtimeRoot(), ".runtime-id"),
  secrets: () => join(runtimeRoot(), "secrets.json"),
  sources: () => join(runtimeRoot(), "sources.json"),
  auditDb: () => join(runtimeRoot(), "audit.db"),
  logsDir: () => join(runtimeRoot(), "logs"),
};
