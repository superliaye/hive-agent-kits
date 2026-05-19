// Threads + Messages CRUD against the shared `hive.db` connection.
// All writes go through this module; consumers (Run executor, future
// HTTP routes, future Settings UI) call these verbs and never touch
// Drizzle directly.

import { asc, eq, max } from "drizzle-orm";
import type { HiveDb } from "../db/hive-db.ts";
import type { ContentBlock, Message } from "../model-gateway/types.ts";
import { messages, threads } from "./schema.ts";
import type { Thread, ThreadMessage } from "./types.ts";

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

  /** Delete a thread and all its messages (cascade). */
  remove(threadId: string): void;
};

export function createThreadsStore(
  db: HiveDb,
  now: () => number = Date.now,
  newId: () => string = () => crypto.randomUUID(),
): ThreadsStore {
  function rowToThread(row: typeof threads.$inferSelect): Thread {
    return {
      id: row.id,
      agentId: row.agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToMessage(row: typeof messages.$inferSelect): ThreadMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
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
      return { id, agentId: input.agentId, createdAt: t, updatedAt: t };
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

    remove(threadId) {
      // Cascading FK deletes messages.
      db.delete(threads).where(eq(threads.id, threadId)).run();
    },
  };
}
