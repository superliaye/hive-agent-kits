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

// `updated_at` is the sort key (most-recent-interaction first) AND is bumped
// ONLY by `append` — no `last_interacted_at` column. The lifecycle verbs
// (setTitle/archive/markRead/markUnread) deliberately do NOT touch it, so it
// keeps meaning "time of the last message". `archived_at` is the single
// lifecycle marker: NULL = active, non-NULL = archived; a deleted thread is a
// gone row. No separate status enum column.
export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  title: text("title"),
  title_source: text("title_source", { enum: ["auto", "manual"] })
    .notNull()
    .default("auto"),
  last_read_at: integer("last_read_at"),
  archived_at: integer("archived_at"),
  // Per-Thread (conversation-scope) model/effort pick (ADR-0015 S1). NULL =
  // unset (fall through to the agent default). Deliberately OPEN `text` columns
  // (ADR-0015 §"Stored conversation-scope values are open strings"): a concrete
  // `provider/model` or effort level, OR a symbolic token ("latest"/"highest").
  // Not narrowed here — the executor's resolver is the SINGLE concretization
  // point at Run start and fails soft.
  model_pref: text("model_pref"),
  effort_pref: text("effort_pref"),
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

// The columns this module expects on `threads`, with the DDL fragment used to
// ADD them to a pre-existing table. CREATE covers fresh DBs; the PRAGMA-guarded
// ALTER below covers DBs created before a column existed (there is no migration
// runner — `openHiveDb` only calls these ensure functions).
const THREADS_ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "title", ddl: "title TEXT" },
  { name: "title_source", ddl: "title_source TEXT NOT NULL DEFAULT 'auto'" },
  { name: "last_read_at", ddl: "last_read_at INTEGER" },
  { name: "archived_at", ddl: "archived_at INTEGER" },
  { name: "model_pref", ddl: "model_pref TEXT" },
  { name: "effort_pref", ddl: "effort_pref TEXT" },
];

// Minimal handle shape: `run` for DDL writes, `$client` (the bun:sqlite
// Database) for the PRAGMA read, which returns rows and so can't go through
// `run`. Satisfied by the full Drizzle `HiveDb` handle passed at boot.
type EnsureHandle = {
  run: (q: ReturnType<typeof sql>) => void;
  $client: { query: <R>(sql: string) => { all: () => R[] } };
};

// IMPORTANT: this DDL must stay in sync with the Drizzle tables above.
// They duplicate the shape today because we're not yet running drizzle-kit
// migrations. When the schema changes, update both places.
export function ensureThreadsSchema(db: EnsureHandle): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT,
      title_source TEXT NOT NULL DEFAULT 'auto',
      last_read_at INTEGER,
      archived_at INTEGER,
      model_pref TEXT,
      effort_pref TEXT
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

  // Idempotent additive migration for DBs that predate the lifecycle columns.
  // No-op on a fresh DB (CREATE already added them). PRAGMA returns rows, so
  // it goes through `$client.query(...).all()`, not `run`.
  const present = new Set(
    db.$client
      .query<{ name: string }>("PRAGMA table_info(threads)")
      .all()
      .map((r) => r.name),
  );
  for (const col of THREADS_ADDED_COLUMNS) {
    if (!present.has(col.name)) {
      db.run(sql.raw(`ALTER TABLE threads ADD COLUMN ${col.ddl}`));
    }
  }
}
