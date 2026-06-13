// Threads + Messages CRUD against the shared `hive.db` connection.
// All writes go through this module; consumers (Run executor, future
// HTTP routes, future Settings UI) call these verbs and never touch
// Drizzle directly.

import { and, asc, eq, isNull, lt, max } from "drizzle-orm";
import type { HiveDb } from "../db/hive-db.ts";
import { AgentId, ThreadId } from "../lib/ids.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { ContentBlock, Message } from "../model-gateway/types.ts";
import { messages, threads } from "./schema.ts";
import type { CliSession, Thread, ThreadEvents, ThreadMessage, TitleSource } from "./types.ts";

export type CreateThreadInput = {
  id?: string;
  agentId: string;
};

export type AppendMessageInput = {
  threadId: string;
  role: "user" | "assistant";
  content: ContentBlock[];
};

export class ThreadNotFoundError extends Error {
  constructor(threadId: string) {
    super(`thread not found: ${threadId}`);
    this.name = "ThreadNotFoundError";
  }
}

export type ThreadsStore = {
  /** Create a new thread for the given agent. Returns the persisted row. */
  create(input: CreateThreadInput): Thread;

  /** Get a thread by id (without messages). Returns undefined if missing. */
  get(threadId: string): Thread | undefined;

  /** Get a thread plus all its messages in order. Returns undefined if missing. */
  getWithMessages(threadId: string): (Thread & { messages: ThreadMessage[] }) | undefined;

  /** List messages on a thread in insertion order. Empty array if missing. */
  listMessages(threadId: string): ThreadMessage[];

  /**
   * Append a message to a thread. Increments the thread's `updatedAt`
   * timestamp. Throws ThreadNotFoundError if the thread doesn't exist.
   * `idx` is assigned to (max(idx) + 1) atomically within a transaction.
   */
  append(input: AppendMessageInput): ThreadMessage;

  /**
   * Get the messages from a thread as a `Message[]` ready to drop into
   * a CompletionInput. Convenience for the Run executor.
   */
  getCompletionMessages(threadId: string): Message[];

  /** List all threads, most-recently-updated first. */
  list(): Thread[];

  /**
   * Set a thread's title. `source==='manual'` always writes and pins
   * `title_source='manual'`; `source==='auto'` no-ops once the title is manual
   * (a user-chosen title is sticky). Does NOT bump `updatedAt`. The manual
   * branch is audit-first (emits `thread.title_set` BEFORE the write); the
   * auto branch never emits. No-op on a missing thread.
   */
  setTitle(threadId: string, title: string, source: TitleSource): Promise<void>;

  /**
   * Archive a thread (set `archived_at` to now()). Idempotent: a second
   * archive keeps the original timestamp and does nothing. `source==='manual'`
   * is audit-first (emits `thread.archived` BEFORE the write); `source==='auto'`
   * (the boot sweep) never emits. Does NOT bump `updatedAt`. No-op on a missing
   * or already-archived thread (no emit on the no-op).
   */
  archive(threadId: string, source: TitleSource): Promise<void>;

  /**
   * Set a thread's conversation-scope pick: model/effort (ADR-0015 S1) and/or
   * the per-conversation Working Directory (ADR-0016 C4 tier 1). A field present
   * in the patch is written (a `null` clears it); an OMITTED field is left
   * unchanged — so the axes stay independent (setting one never clobbers
   * another). Audit-first: emits `thread.scope_set` (carrying the touched axes)
   * BEFORE the write (ADR-0004). Does NOT bump `updatedAt` (a metadata edit, not
   * a message). No-op on a missing thread. A no-op patch (no field present) is
   * rejected as a caller bug.
   *
   * The patch values are deliberately raw `string | null`, NOT narrowed to a
   * `ModelDefault | EffortDefault` (ADR-0015 §"Stored conversation-scope values
   * are open strings"): the store accepts a concrete value OR a symbolic token
   * ("latest"/"highest") verbatim. The resolver at Run start is the SINGLE
   * concretization point and fails soft — the store never classifies.
   */
  setScope(
    threadId: string,
    patch: {
      model?: string | null;
      effort?: string | null;
      workingDir?: string | null;
      backend?: string | null;
    },
  ): Promise<void>;

  /**
   * Read a thread's stored CLI native-session token (ADR-0016), or undefined
   * when none is stored (or the thread is missing). The executor uses this to
   * decide create-vs-resume; a stale token (backend mismatch) is the caller's to
   * ignore.
   */
  getCliSession(threadId: string): CliSession | undefined;

  /**
   * Persist a thread's CLI native-session token (ADR-0016) after a successful
   * CLI create. Internal continuity state, NOT a user action — deliberately not
   * audited (kept off the audit subscribe path) and does NOT bump `updatedAt`.
   * No-op on a missing thread.
   */
  setCliSession(threadId: string, session: CliSession): void;

  /** Mark a thread read at `at`. Sets `last_read_at`. Not audited. Sync. */
  markRead(threadId: string, at: number): void;

  /**
   * Mark a thread unread (clear `last_read_at`). Audit-first: emits
   * `thread.marked_unread` BEFORE the write. No-op on a missing thread.
   */
  markUnread(threadId: string): Promise<void>;

  /**
   * Active threads (archived_at IS NULL) whose `updated_at` is strictly before
   * `cutoff`. The query the auto-archive boot sweep enumerates. Read-only.
   */
  listActiveIdleBefore(cutoff: number): Thread[];

  /**
   * Delete a thread and all its messages (cascade). Audit-first: emits
   * `thread.deleted` BEFORE the delete. No-op (no emit) on a missing thread.
   */
  remove(threadId: string): Promise<void>;

  events: TypedEmitter<ThreadEvents>;
};

export function createThreadsStore(
  db: HiveDb,
  now: () => number = Date.now,
  newId: () => string = () => crypto.randomUUID(),
): ThreadsStore {
  const events = new TypedEmitter<ThreadEvents>();

  function rowToThread(row: typeof threads.$inferSelect): Thread {
    return {
      id: ThreadId.parse(row.id),
      agentId: AgentId.parse(row.agent_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      titleSource: row.title_source,
      lastReadAt: row.last_read_at,
      archivedAt: row.archived_at,
      modelPref: row.model_pref,
      effortPref: row.effort_pref,
      workingDir: row.working_dir,
      backend: row.backend,
      cliSessionBackend: row.cli_session_backend,
      cliSessionId: row.cli_session_id,
    };
  }

  function rowToMessage(row: typeof messages.$inferSelect): ThreadMessage {
    return {
      id: row.id,
      threadId: ThreadId.parse(row.thread_id),
      idx: row.idx,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    };
  }

  return {
    create(input) {
      const id = input.id ?? newId();
      const t = now();
      db.insert(threads)
        .values({ id, agent_id: input.agentId, created_at: t, updated_at: t })
        .run();
      return {
        id: ThreadId.parse(id),
        agentId: AgentId.parse(input.agentId),
        createdAt: t,
        updatedAt: t,
        title: null,
        titleSource: "auto",
        lastReadAt: null,
        archivedAt: null,
        modelPref: null,
        effortPref: null,
        workingDir: null,
        backend: null,
        cliSessionBackend: null,
        cliSessionId: null,
      };
    },

    get(threadId) {
      const rows = db.select().from(threads).where(eq(threads.id, threadId)).all();
      const row = rows[0];
      return row ? rowToThread(row) : undefined;
    },

    getWithMessages(threadId) {
      const thread = this.get(threadId);
      if (!thread) return undefined;
      return { ...thread, messages: this.listMessages(threadId) };
    },

    listMessages(threadId) {
      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.thread_id, threadId))
        .orderBy(asc(messages.idx))
        .all();
      return rows.map(rowToMessage);
    },

    append(input) {
      // bun:sqlite is synchronous; wrap in a transaction so the (max idx
      // lookup + insert + thread.updated_at update) are atomic relative
      // to other writers on the same thread.
      const t = now();
      const messageId = newId();
      let inserted: typeof messages.$inferSelect | undefined;

      db.transaction((tx) => {
        const existing = tx
          .select({ exists: threads.id })
          .from(threads)
          .where(eq(threads.id, input.threadId))
          .all();
        if (existing.length === 0) {
          throw new ThreadNotFoundError(input.threadId);
        }
        const maxRow = tx
          .select({ maxIdx: max(messages.idx) })
          .from(messages)
          .where(eq(messages.thread_id, input.threadId))
          .all();
        const nextIdx = (maxRow[0]?.maxIdx ?? -1) + 1;
        inserted = tx
          .insert(messages)
          .values({
            id: messageId,
            thread_id: input.threadId,
            idx: nextIdx,
            role: input.role,
            content: input.content,
            created_at: t,
          })
          .returning()
          .all()[0];
        tx.update(threads).set({ updated_at: t }).where(eq(threads.id, input.threadId)).run();
      });

      if (!inserted) {
        // Shouldn't happen — transaction either threw or returned the row.
        throw new Error("threads/store: append produced no row");
      }
      return rowToMessage(inserted);
    },

    getCompletionMessages(threadId) {
      const list = this.listMessages(threadId);
      return list.map((m) => ({ role: m.role, content: m.content }));
    },

    list() {
      const rows = db.select().from(threads).all();
      return rows.map(rowToThread).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async setTitle(threadId, title, source) {
      const current = this.get(threadId);
      if (!current) return;
      // A user-chosen title is sticky: an auto write never clobbers manual.
      if (source === "auto" && current.titleSource === "manual") return;

      if (source === "manual") {
        // Audit-first: emit BEFORE the write (ADR-0004). Refs only — the title
        // string is NOT in the payload.
        await events.emit("thread.title_set", {
          threadId: current.id,
          agentId: current.agentId,
          titleSource: "manual",
        });
      }
      // No updated_at bump — the sort key tracks messages, not metadata edits.
      db.update(threads).set({ title, title_source: source }).where(eq(threads.id, threadId)).run();
    },

    async archive(threadId, source) {
      const current = this.get(threadId);
      if (!current) return;
      // Idempotent: keep the first archive timestamp; a re-archive is a true
      // no-op and emits nothing (no state change → no audit row).
      if (current.archivedAt !== null) return;

      if (source === "manual") {
        await events.emit("thread.archived", { threadId: current.id, agentId: current.agentId });
      }
      // No updated_at bump.
      db.update(threads).set({ archived_at: now() }).where(eq(threads.id, threadId)).run();
    },

    async setScope(threadId, patch) {
      const hasModel = patch.model !== undefined;
      const hasEffort = patch.effort !== undefined;
      const hasWorkingDir = patch.workingDir !== undefined;
      const hasBackend = patch.backend !== undefined;
      if (!hasModel && !hasEffort && !hasWorkingDir && !hasBackend) {
        throw new Error(
          "threads/store: setScope requires at least one of { model, effort, workingDir, backend }",
        );
      }
      const current = this.get(threadId);
      if (!current) return;

      // Audit-first: emit BEFORE the write (ADR-0004). A set carries its new
      // value in `model`/`effort`/`workingDir`/`backend`; a clear (axis touched,
      // value null) is named in `cleared` so clear-X stays distinguishable in
      // audit without making the value fields nullable. The write still clears.
      const cleared: ("model" | "effort" | "workingDir" | "backend")[] = [];
      if (hasModel && patch.model === null) cleared.push("model");
      if (hasEffort && patch.effort === null) cleared.push("effort");
      if (hasWorkingDir && patch.workingDir === null) cleared.push("workingDir");
      if (hasBackend && patch.backend === null) cleared.push("backend");
      await events.emit("thread.scope_set", {
        threadId: current.id,
        agentId: current.agentId,
        ...(hasModel && patch.model !== null ? { model: patch.model } : {}),
        ...(hasEffort && patch.effort !== null ? { effort: patch.effort } : {}),
        ...(hasWorkingDir && patch.workingDir !== null ? { workingDir: patch.workingDir } : {}),
        ...(hasBackend && patch.backend !== null ? { backend: patch.backend } : {}),
        ...(cleared.length > 0 ? { cleared } : {}),
      });

      // Merge: write only the touched columns (no updated_at bump). An omitted
      // axis keeps its stored value, so the axes stay independent.
      db.update(threads)
        .set({
          ...(hasModel ? { model_pref: patch.model } : {}),
          ...(hasEffort ? { effort_pref: patch.effort } : {}),
          ...(hasWorkingDir ? { working_dir: patch.workingDir } : {}),
          ...(hasBackend ? { backend: patch.backend } : {}),
        })
        .where(eq(threads.id, threadId))
        .run();
    },

    getCliSession(threadId) {
      const current = this.get(threadId);
      if (!current || current.cliSessionBackend === null || current.cliSessionId === null) {
        return undefined;
      }
      return { backend: current.cliSessionBackend, sessionId: current.cliSessionId };
    },

    setCliSession(threadId, session) {
      // Internal continuity state — not audited, no updated_at bump.
      db.update(threads)
        .set({ cli_session_backend: session.backend, cli_session_id: session.sessionId })
        .where(eq(threads.id, threadId))
        .run();
    },

    markRead(threadId, at) {
      // Not audited; no updated_at bump.
      db.update(threads).set({ last_read_at: at }).where(eq(threads.id, threadId)).run();
    },

    async markUnread(threadId) {
      const current = this.get(threadId);
      if (!current) return;
      await events.emit("thread.marked_unread", { threadId: current.id, agentId: current.agentId });
      db.update(threads).set({ last_read_at: null }).where(eq(threads.id, threadId)).run();
    },

    listActiveIdleBefore(cutoff) {
      const rows = db
        .select()
        .from(threads)
        .where(and(isNull(threads.archived_at), lt(threads.updated_at, cutoff)))
        .all();
      return rows.map(rowToThread);
    },

    async remove(threadId) {
      const current = this.get(threadId);
      if (!current) return;
      // Audit-first: emit BEFORE the delete.
      await events.emit("thread.deleted", { threadId: current.id, agentId: current.agentId });
      // Cascading FK deletes messages.
      db.delete(threads).where(eq(threads.id, threadId)).run();
    },

    events,
  };
}
