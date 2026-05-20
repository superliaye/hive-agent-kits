// Path resolution for Hive's two-tier storage model.
//
// Two roots:
//   - BUNDLED: lives with the Hive package (the repo's bundled/ in dev mode,
//     the daemon's install resources in a packaged app). Immutable at runtime.
//   - RUNTIME: lives in OS app-storage (~/.hive/ today; future: Electron's
//     app.getPath('userData')). Mutable per install.
//
// Both roots are env-overridable for tests:
//   HIVE_BUNDLED_ROOT, HIVE_RUNTIME_ROOT
//
// See docs/adr/0007-capability-lifecycle-and-storage.md.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Origin } from "./capability-types.ts";

export function bundledRoot(): string {
  if (process.env.HIVE_BUNDLED_ROOT) return process.env.HIVE_BUNDLED_ROOT;
  // src/lib/paths.ts -> ../../bundled
  return resolve(import.meta.dir, "..", "..", "bundled");
}

export function runtimeRoot(): string {
  if (process.env.HIVE_RUNTIME_ROOT) return process.env.HIVE_RUNTIME_ROOT;
  return join(homedir(), ".hive");
}

function bundledOriginRoot(origin: Origin, workplaceId?: string): string {
  if (origin === "personal") return join(bundledRoot(), "personal");
  if (!workplaceId) {
    throw new Error("workplaceId required for workplace-origin paths");
  }
  return join(bundledRoot(), "workplace", workplaceId);
}

// Bundled — origin-aware Capability dirs. Workplace requires an id.
export const bundled = {
  root: bundledRoot,
  skill: (origin: Origin, name: string, workplaceId?: string) =>
    join(bundledOriginRoot(origin, workplaceId), "skills", name),
  snippet: (origin: Origin, name: string, workplaceId?: string) =>
    join(bundledOriginRoot(origin, workplaceId), "snippets", name),
  mcp: (origin: Origin, name: string, workplaceId?: string) =>
    join(bundledOriginRoot(origin, workplaceId), "mcp", name),
  skillsDir: (origin: Origin, workplaceId?: string) =>
    join(bundledOriginRoot(origin, workplaceId), "skills"),
  snippetsDir: (origin: Origin, workplaceId?: string) =>
    join(bundledOriginRoot(origin, workplaceId), "snippets"),
  mcpDir: (origin: Origin, workplaceId?: string) =>
    join(bundledOriginRoot(origin, workplaceId), "mcp"),
  workplaceDir: () => join(bundledRoot(), "workplace"),
  agentsDir: () => join(bundledRoot(), "agents"),
  // Agents are not origin-tagged at the bundled layer — Root and Agent Manager
  // are always there; Worker Agents never live in bundled.
  agent: (id: string) => join(bundledRoot(), "agents", id),
};

// Runtime — implicit personal scope, no origin axis.
export const runtime = {
  root: runtimeRoot,
  skill: (name: string) => join(runtimeRoot(), "capabilities", "skills", name),
  snippet: (name: string) => join(runtimeRoot(), "capabilities", "snippets", name),
  mcp: (name: string) => join(runtimeRoot(), "capabilities", "mcp", name),
  skillsDir: () => join(runtimeRoot(), "capabilities", "skills"),
  snippetsDir: () => join(runtimeRoot(), "capabilities", "snippets"),
  mcpDir: () => join(runtimeRoot(), "capabilities", "mcp"),
  agentsDir: () => join(runtimeRoot(), "agents"),
  agent: (id: string) => join(runtimeRoot(), "agents", id),
  agentMemory: (id: string) => join(runtimeRoot(), "agents", id, "memory"),
  agentThreads: (id: string) => join(runtimeRoot(), "agents", id, "threads"),
};

// Files that live only in the runtime tier.
export const files = {
  config: () => join(runtimeRoot(), "config.yaml"),
  token: () => join(runtimeRoot(), ".token"),
  secrets: () => join(runtimeRoot(), "secrets.json"),
  appearance: () => join(runtimeRoot(), "appearance.json"),
  auditDb: () => join(runtimeRoot(), "audit.db"),
  auditArchiveDir: () => join(runtimeRoot(), "audit-archive"),
  hiveDb: () => join(runtimeRoot(), "hive.db"),
  logsDir: () => join(runtimeRoot(), "logs"),
};
