// Trace log — system diagnostics, separate from the audit log.
//
// Audit (src/audit/) records user/agent-driven side effects and decisions
// for "what happened" questions. Trace (this file) captures parse errors,
// watcher events, daemon startup chatter, performance counters, and other
// diagnostics for "why didn't this work" questions. See ADR-0004.
//
// Mode is explicit at creation, mirroring Audit/Config/Server: the daemon's
// `createServer({mode})` chooses and installs the singleton; tests get the
// safe default (silent) until they explicitly install one. No env-sniffing
// inside the logger itself.

import { mkdirSync } from "node:fs";
import pino, { type Logger } from "pino";
import { files } from "./paths.ts";

export type LogMode = "silent" | "file" | "stdout";

// Singleton — silent by default so unconfigured tests don't litter. The
// daemon installs the real one via `setLogger(createLogger({mode: "file"}))`
// during boot.
let current: Logger = pino({ level: "silent" });

export function log(): Logger {
  return current;
}

export function setLogger(logger: Logger): void {
  current = logger;
}

export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

export function createLogger(opts: { mode: LogMode; level?: pino.Level }): Logger {
  const level = opts.level ?? (process.env.HIVE_LOG_LEVEL as pino.Level | undefined) ?? "info";
  switch (opts.mode) {
    case "silent":
      return pino({ level: "silent" });
    case "stdout":
      return pino({ level });
    case "file": {
      try {
        const logPath = `${files.logsDir()}/daemon.log`;
        mkdirSync(files.logsDir(), { recursive: true });
        return pino(
          { level },
          pino.destination({ dest: logPath, sync: false, mkdir: true }),
        );
      } catch {
        // Fall back to stdout JSONL if the runtime dir isn't writable.
        return pino({ level });
      }
    }
  }
}
