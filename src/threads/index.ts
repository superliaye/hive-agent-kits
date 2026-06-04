// Public API for the Threads module.
//
// Threads + Messages are persisted in `~/.hive/hive.db` (shared with
// Runs and future hot-state modules per ADR-0002). Memory mode uses an
// in-memory SQLite — same schema, same semantics, lost on process exit.

import { type HiveDb, openHiveDb } from "../db/hive-db.ts";
import { createThreadsStore, ThreadNotFoundError, type ThreadsStore } from "./store.ts";

export type Threads = ThreadsStore;

export type CreateThreadsOptions =
  | { mode: "memory" }
  | { mode: "file"; path: string }
  | { mode: "shared"; db: HiveDb };

/**
 * Construct a Threads handle.
 *
 * - `mode: "memory"` — opens an in-memory bun:sqlite, applies the bootstrap
 *   DDL. For tests.
 * - `mode: "file"` — opens `hive.db` at the given path; bootstraps if new.
 *   For production.
 * - `mode: "shared"` — reuses an existing `HiveDb` handle. For when Threads
 *   and Runs share one connection inside a server boot. The opener has
 *   already applied the schema.
 */
export function createThreads(opts: CreateThreadsOptions): Threads {
  switch (opts.mode) {
    case "memory":
      return createThreadsStore(openHiveDb(":memory:"));
    case "file":
      return createThreadsStore(openHiveDb(opts.path));
    case "shared":
      return createThreadsStore(opts.db);
  }
}

export type { AppendMessageInput, CreateThreadInput } from "./store.ts";
export type { Thread, ThreadMessage, ThreadWithMessages } from "./types.ts";
export { ThreadNotFoundError };
