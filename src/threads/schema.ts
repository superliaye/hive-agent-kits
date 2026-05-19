// Drizzle schema for the `threads` and `messages` tables. Lives in
// `~/.hive/hive.db` shared across threads/runs/future hot-state modules
// per ADR-0002.
//
// Messages are normalized into their own table (not denormalized as a
// JSON column on threads). Per-message addressing — edit message N, retry
// from message N, future FTS5 search — would be painful to retrofit
// against a denormalized blob. ADR-0008 sequel: ADR for run pipeline.
//
// `content` is a JSON column carrying ContentBlock[] per
// `model-gateway/types.ts`. Schema-flexible at the column boundary;
// Zod-validated by the application layer when written or read.
//
// `idx` is the message's position within its thread (0-based, monotonic).
// Used for stable ordering and "retry from N" addressing.

import { sql } from "drizzle-orm";
import { foreignKey, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ContentBlock } from "../model-gateway/types.ts";

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    thread_id: text("thread_id").notNull(),
    idx: integer("idx").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content", { mode: "json" }).notNull().$type<ContentBlock[]>(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_messages_thread_idx").on(t.thread_id, t.idx),
    foreignKey({ columns: [t.thread_id], foreignColumns: [threads.id] }).onDelete("cascade"),
  ],
);

// IMPORTANT: this DDL must stay in sync with the Drizzle tables above.
// They duplicate the shape today because we're not yet running drizzle-kit
// migrations. When the schema changes, update both places.
export function ensureThreadsSchema(db: { run: (q: ReturnType<typeof sql>) => void }): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_thread_idx ON messages (thread_id, idx)`);
}
