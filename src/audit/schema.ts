// Drizzle schema for the audit_events table per ADR-0004.
// Single table; JSON payload absorbs schema evolution without table migrations.
// `prev_hash` and `signature` are v1.1 tamper-evidence hooks (null in v1).
//
// IMPORTANT: bootstrap DDL is duplicated in `db.ts` (CREATE TABLE IF NOT EXISTS).
// Keep the two in sync until we migrate to drizzle-kit migrations.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    // Microseconds since epoch (not ms — see types.ts).
    ts: integer("ts").notNull(),
    // Monotonic counter tiebreaker; total order is (ts, seq).
    seq: integer("seq").notNull(),
    run_id: text("run_id"),
    agent_id: text("agent_id"),
    source: text("source").notNull(),
    event_type: text("event_type").notNull(),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    parent_event_id: text("parent_event_id"),
    prev_hash: text("prev_hash"),
    signature: text("signature"),
  },
  (t) => [
    index("idx_audit_run_ts").on(t.run_id, t.ts, t.seq),
    index("idx_audit_agent_ts").on(t.agent_id, t.ts, t.seq),
    index("idx_audit_source_ts").on(t.source, t.ts, t.seq),
  ],
);
