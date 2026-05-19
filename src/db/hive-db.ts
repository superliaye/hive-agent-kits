// Shared `hive.db` connection — the single SQLite file for hot conversation
// state (threads, messages, runs) per ADR-0002 §"User data location".
//
// `audit.db` (ADR-0004) is a separate file with its own opener; audit and
// hot-state don't share a connection because audit's append-only write
// pattern + WAL + future archive rotation differs from the conversation
// state's mixed read/update pattern.
//
// Bootstrap DDL is duplicated in each module's `ensureSchema()` function
// (called by `openHiveDb`). When drizzle-kit migrations are introduced,
// this opener swaps the `ensureSchema` calls for a single migration apply.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureRunsSchema } from "../runs/schema.ts";
import * as runsSchema from "../runs/schema.ts";
import { ensureThreadsSchema } from "../threads/schema.ts";
import * as threadsSchema from "../threads/schema.ts";

const combinedSchema = {
  ...threadsSchema,
  ...runsSchema,
};

export type HiveDb = ReturnType<typeof drizzle<typeof combinedSchema>>;

export function openHiveDb(path: string): HiveDb {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema: combinedSchema });
  ensureThreadsSchema(db);
  ensureRunsSchema(db);
  return db;
}
