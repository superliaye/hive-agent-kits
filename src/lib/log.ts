// Trace log — system diagnostics, separate from the audit log.
//
// Audit (src/audit/) records user/agent-driven side effects and decisions
// for "what happened" questions. Trace (this file) captures parse errors,
// watcher events, daemon startup chatter, performance counters, and other
// diagnostics for "why didn't this work" questions. See ADR-0004.
//
// Pino writes JSONL to <runtime>/logs/daemon.log. Bun's runtime captures
// stdout too, so a `tail -f <runtime>/logs/daemon.log` plus daemon stdout
// covers most debugging.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";
import { files } from "./paths.ts";

let cached: Logger | null = null;

// Modules call `log()` to get the singleton; tests can override via
// `setLogger()` to inject a silent logger and assert on captured records.
export function log(): Logger {
  if (cached) return cached;
  cached = createDefaultLogger();
  return cached;
}

export function setLogger(logger: Logger): void {
  cached = logger;
}

// Test helper: silent logger that drops every write.
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

function createDefaultLogger(): Logger {
  // Bun's test runner sets a global flag we can sniff. In-process tests
  // should never spam a real file.
  const inTest =
    typeof (globalThis as { Bun?: { jest?: unknown } }).Bun?.jest !== "undefined" ||
    process.env.NODE_ENV === "test";
  if (inTest) return silentLogger();

  try {
    const logPath = `${files.logsDir()}/daemon.log`;
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(dirname(logPath))) {
      return pino({ level: "info" });
    }
    return pino(
      { level: process.env.HIVE_LOG_LEVEL ?? "info" },
      pino.destination({ dest: logPath, sync: false, mkdir: true }),
    );
  } catch {
    // Fall back to stdout JSONL if the runtime dir isn't writable.
    return pino({ level: process.env.HIVE_LOG_LEVEL ?? "info" });
  }
}
