// Drizzle schema for the `runs` table. Lives in `~/.hive/hive.db` shared
// with threads/messages per ADR-0002.
//
// One row per Run (one turn = one full `complete()` cycle from the
// model). `status` transitions: running → completed | failed | cancelled.
// On daemon restart, any rows still `running` are stale (the streaming
// consumer is gone) — `markStaleRunsFailed()` flips them to `failed` with
// error_code = "daemon_restart". See ADR for run-pipeline.
//
// Per-token deltas are NOT persisted here (Q8: hybrid — lifecycle yes,
// stream contents no). The final assistant message lands in the
// `messages` table normally; this row records that the Run happened.

import { sql } from "drizzle-orm";
import { foreignKey, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { threads } from "../threads/schema.ts";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    thread_id: text("thread_id").notNull(),
    agent_id: text("agent_id").notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["running", "completed", "failed", "cancelled"] }).notNull(),
    started_at: integer("started_at").notNull(),
    ended_at: integer("ended_at"),
    finish_reason: text("finish_reason"),
    error_code: text("error_code"),
    error_message: text("error_message"),
  },
  (t) => [
    index("idx_runs_thread_started").on(t.thread_id, t.started_at),
    index("idx_runs_status").on(t.status),
    foreignKey({ columns: [t.thread_id], foreignColumns: [threads.id] }).onDelete("cascade"),
  ],
);

// IMPORTANT: this DDL must stay in sync with the Drizzle table above.
export function ensureRunsSchema(db: { run: (q: ReturnType<typeof sql>) => void }): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      finish_reason TEXT,
      error_code TEXT,
      error_message TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_runs_thread_started ON runs (thread_id, started_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status)`);
}
