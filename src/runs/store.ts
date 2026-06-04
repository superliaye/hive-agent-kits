// CRUD for the `runs` table. The Run executor uses this to record
// lifecycle; future query routes (list runs on a thread, get a single
// Run by id) consume the same verbs.

import { and, asc, eq } from "drizzle-orm";
import type { HiveDb } from "../db/hive-db.ts";
import type { FinishReason } from "../model-gateway/types.ts";
import { type RunStatus, runs } from "./schema.ts";
import type { Run } from "./types.ts";

export type CreateRunInput = {
  id?: string;
  threadId: string;
  agentId: string;
  model: string;
};

export type CompleteRunInput = {
  runId: string;
  finishReason: FinishReason;
};

export type FailRunInput = {
  runId: string;
  code: NonNullable<Run["errorCode"]>;
  message: string;
};

export type RunsStore = {
  /** Insert a fresh `running` Run row. */
  create(input: CreateRunInput): Run;

  /** Mark a Run as completed with a finishReason. */
  complete(input: CompleteRunInput): void;

  /** Mark a Run as failed with a classified code + message. */
  fail(input: FailRunInput): void;

  /** Mark a Run as cancelled. */
  cancel(runId: string): void;

  /** Get a single Run by id. Undefined if missing. */
  get(runId: string): Run | undefined;

  /** List Runs on a thread, oldest first. */
  listByThread(threadId: string): Run[];

  /** List all Runs in a given status. Used for boot-time stale recovery. */
  listByStatus(status: RunStatus): Run[];

  /**
   * Mark every still-`running` Run as failed with code=`daemon_restart`.
   * Called once at server boot — no consumer is still streaming a Run
   * left over from a previous process. Returns count of rows updated.
   */
  markStaleAsFailed(): number;
};

export function createRunsStore(db: HiveDb, now: () => number = Date.now): RunsStore {
  function rowToRun(row: typeof runs.$inferSelect): Run {
    const out: Run = {
      id: row.id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      model: row.model,
      status: row.status,
      startedAt: row.started_at,
    };
    if (row.ended_at !== null) out.endedAt = row.ended_at;
    if (row.finish_reason !== null) out.finishReason = row.finish_reason as FinishReason;
    if (row.error_code !== null) out.errorCode = row.error_code as Run["errorCode"];
    if (row.error_message !== null) out.errorMessage = row.error_message;
    return out;
  }

  return {
    create(input) {
      const id = input.id ?? crypto.randomUUID();
      const t = now();
      const row = db
        .insert(runs)
        .values({
          id,
          thread_id: input.threadId,
          agent_id: input.agentId,
          model: input.model,
          status: "running",
          started_at: t,
        })
        .returning()
        .all()[0];
      if (!row) throw new Error("runs/store: create produced no row");
      return rowToRun(row);
    },

    complete({ runId, finishReason }) {
      db.update(runs)
        .set({ status: "completed", ended_at: now(), finish_reason: finishReason })
        .where(and(eq(runs.id, runId), eq(runs.status, "running")))
        .run();
    },

    fail({ runId, code, message }) {
      db.update(runs)
        .set({
          status: "failed",
          ended_at: now(),
          error_code: code,
          error_message: message,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "running")))
        .run();
    },

    cancel(runId) {
      db.update(runs)
        .set({ status: "cancelled", ended_at: now() })
        .where(and(eq(runs.id, runId), eq(runs.status, "running")))
        .run();
    },

    get(runId) {
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      return row ? rowToRun(row) : undefined;
    },

    listByThread(threadId) {
      const rows = db
        .select()
        .from(runs)
        .where(eq(runs.thread_id, threadId))
        .orderBy(asc(runs.started_at))
        .all();
      return rows.map(rowToRun);
    },

    listByStatus(status) {
      const rows = db.select().from(runs).where(eq(runs.status, status)).all();
      return rows.map(rowToRun);
    },

    markStaleAsFailed() {
      const stale = this.listByStatus("running");
      const t = now();
      for (const r of stale) {
        db.update(runs)
          .set({
            status: "failed",
            ended_at: t,
            error_code: "daemon_restart",
            error_message: "daemon restarted while run was in flight",
          })
          .where(eq(runs.id, r.id))
          .run();
      }
      return stale.length;
    },
  };
}
