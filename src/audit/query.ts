// Audit query implementation. Sync over Bun's sqlite; wrapped as Promise
// at the public boundary for future-proofing toward async backends.

import { type SQL, and, desc, eq, gte, lte } from "drizzle-orm";
import type { AuditDb } from "./db.ts";
import { auditEvents } from "./schema.ts";
import type { AuditEvent, AuditQueryFilter, ModuleSource } from "./types.ts";

export function runQuery(db: AuditDb, filter: AuditQueryFilter): AuditEvent[] {
  const conditions: SQL[] = [];
  if (filter.run_id !== undefined) conditions.push(eq(auditEvents.run_id, filter.run_id));
  if (filter.agent_id !== undefined) conditions.push(eq(auditEvents.agent_id, filter.agent_id));
  if (filter.source !== undefined) conditions.push(eq(auditEvents.source, filter.source));
  if (filter.event_type !== undefined) {
    conditions.push(eq(auditEvents.event_type, filter.event_type));
  }
  if (filter.since !== undefined) conditions.push(gte(auditEvents.ts, filter.since));
  if (filter.until !== undefined) conditions.push(lte(auditEvents.ts, filter.until));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = filter.limit ?? 1000;

  // Total order is (ts DESC, seq DESC). `seq` disambiguates events that
  // share a microsecond — without it ordering would be nondeterministic
  // for rapid-fire emits.
  const rows = db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.ts), desc(auditEvents.seq))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    seq: row.seq,
    run_id: row.run_id,
    agent_id: row.agent_id,
    source: row.source as ModuleSource,
    event_type: row.event_type,
    payload: row.payload,
    parent_event_id: row.parent_event_id,
    prev_hash: row.prev_hash,
    signature: row.signature,
  }));
}
