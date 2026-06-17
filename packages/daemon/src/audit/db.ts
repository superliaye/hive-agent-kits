// Audit SQLite connection helper. Bun's native sqlite + Drizzle.
// Bootstrap-creates the schema on first open; drizzle-kit migrations can
// take over later without changing this surface.

import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

export type AuditDb = ReturnType<typeof drizzle<typeof schema>>;

export function openAuditDb(path: string): AuditDb {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema });
  ensureSchema(db);
  return db;
}

// IMPORTANT: this DDL must stay in sync with the Drizzle table in `schema.ts`.
// They duplicate the shape today because we're not yet running drizzle-kit
// migrations. When the schema changes, update both places.
function ensureSchema(db: AuditDb): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      run_id TEXT,
      agent_id TEXT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      parent_event_id TEXT,
      prev_hash TEXT,
      signature TEXT
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_run_ts ON audit_events (run_id, ts, seq)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_agent_ts ON audit_events (agent_id, ts, seq)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_source_ts ON audit_events (source, ts, seq)`);
}
