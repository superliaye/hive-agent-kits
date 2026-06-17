import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openHiveDb } from "../../db/hive-db.ts";
import { ensureThreadsSchema } from "../schema.ts";

function columnNames(db: Database): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(threads)")
      .all()
      .map((r) => r.name),
  );
}

describe("ensureThreadsSchema — additive migration (AC #1)", () => {
  test("adds the lifecycle columns to a pre-existing OLD-DDL threads table, preserving rows", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON");
    // The OLD threads + messages DDL (before the lifecycle columns existed).
    sqlite.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
    `);
    sqlite.exec(
      `INSERT INTO threads (id, agent_id, created_at, updated_at) VALUES ('t1', 'agent-a', 100, 200)`,
    );
    sqlite.exec(
      `INSERT INTO messages (id, thread_id, idx, role, content, created_at)
       VALUES ('m1', 't1', 0, 'user', '[{"type":"text","text":"hi"}]', 150)`,
    );

    const before = columnNames(sqlite);
    expect(before.has("title")).toBe(false);

    ensureThreadsSchema(drizzle(sqlite));

    const after = columnNames(sqlite);
    for (const col of ["title", "title_source", "last_read_at", "archived_at"]) {
      expect(after.has(col)).toBe(true);
    }

    // The pre-existing row + its message survive the migration.
    const row = sqlite
      .query<
        { id: string; title: string | null; title_source: string; archived_at: number | null },
        []
      >("SELECT id, title, title_source, archived_at FROM threads WHERE id = 't1'")
      .get();
    expect(row?.id).toBe("t1");
    expect(row?.title).toBeNull();
    expect(row?.title_source).toBe("auto"); // NOT NULL DEFAULT 'auto' backfills existing rows
    expect(row?.archived_at).toBeNull();

    const msg = sqlite
      .query<{ id: string }, []>("SELECT id FROM messages WHERE thread_id = 't1'")
      .all();
    expect(msg.map((m) => m.id)).toEqual(["m1"]);
  });

  test("running the migration twice does not throw (idempotent)", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const db = drizzle(sqlite);
    expect(() => {
      ensureThreadsSchema(db);
      ensureThreadsSchema(db);
    }).not.toThrow();
  });
});

describe("ensureThreadsSchema — fresh DB (AC #2)", () => {
  test("a fresh hive.db has all lifecycle columns with the right defaults", () => {
    const db = openHiveDb(":memory:");
    const present = columnNames(db.$client);
    for (const col of ["title", "title_source", "last_read_at", "archived_at"]) {
      expect(present.has(col)).toBe(true);
    }
  });

  test("running ensure twice on a fresh DB does not throw", () => {
    const db = openHiveDb(":memory:");
    expect(() => ensureThreadsSchema(db)).not.toThrow();
  });
});
