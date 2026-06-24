import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SOURCES_FILE_VERSION } from "../../types.ts";
import { DuplicateOrigin, SourceNotFound } from "../errors.ts";
import { SourceRegistry, SourceRegistryLive } from "../sources-live.ts";

const STARTER_ID = "starter";
const STARTER_ORIGIN = "local:starter";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("SourceRegistryLive — file mode lifecycle", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-sources-live-"));
    path = join(root, "sources.json");
    // These tests exercise the lifecycle verbs in isolation, not first-run
    // seeding: write an empty file so the `!persist.exists()` seed gate is skipped
    // (seeding has its own describe block below).
    writeFileSync(path, JSON.stringify({ version: SOURCES_FILE_VERSION, sources: [] }), "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function svc() {
    const rt = ManagedRuntime.make(SourceRegistryLive({ mode: "file", path }));
    return { svc: rt.runSync(SourceRegistry), rt };
  }

  test("add → list shows it (active, uuid id ≠ origin, has createdAt)", async () => {
    const { svc: s, rt } = svc();
    const origin = "https://github.com/a/b";
    const created = await Effect.runPromise(s.add(origin));
    expect(created.active).toBe(true);
    expect(created.origin).toBe(origin);
    expect(UUID_RE.test(created.id)).toBe(true);
    expect(created.id).not.toBe(origin);
    expect(Number.isInteger(created.createdAt)).toBe(true);

    const list = await Effect.runPromise(s.list());
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
    rt.dispose();
  });

  test("add duplicate origin (and .git / trailing-slash variant) yields DuplicateOrigin", async () => {
    const { svc: s, rt } = svc();
    await Effect.runPromise(s.add("https://github.com/a/b"));

    const dupPlain = await Effect.runPromise(Effect.flip(s.add("https://github.com/a/b")));
    expect(dupPlain).toBeInstanceOf(DuplicateOrigin);

    const dupGit = await Effect.runPromise(Effect.flip(s.add("https://github.com/a/b.git")));
    expect(dupGit).toBeInstanceOf(DuplicateOrigin);

    const dupSlash = await Effect.runPromise(Effect.flip(s.add("https://github.com/a/b/")));
    expect(dupSlash).toBeInstanceOf(DuplicateOrigin);

    expect(await Effect.runPromise(s.list())).toHaveLength(1);
    rt.dispose();
  });

  test("deactivate → active:false; activate → active:true", async () => {
    const { svc: s, rt } = svc();
    const created = await Effect.runPromise(s.add("https://github.com/a/b"));

    const off = await Effect.runPromise(s.deactivate(created.id));
    expect(off.active).toBe(false);

    const on = await Effect.runPromise(s.activate(created.id));
    expect(on.active).toBe(true);
    rt.dispose();
  });

  test("delete → gone", async () => {
    const { svc: s, rt } = svc();
    const created = await Effect.runPromise(s.add("https://github.com/a/b"));
    await Effect.runPromise(s.delete(created.id));
    expect(await Effect.runPromise(s.list())).toHaveLength(0);
    rt.dispose();
  });

  test("activate / deactivate / delete on unknown id → SourceNotFound", async () => {
    const { svc: s, rt } = svc();
    expect(await Effect.runPromise(Effect.flip(s.activate("nope")))).toBeInstanceOf(SourceNotFound);
    expect(await Effect.runPromise(Effect.flip(s.deactivate("nope")))).toBeInstanceOf(
      SourceNotFound,
    );
    expect(await Effect.runPromise(Effect.flip(s.delete("nope")))).toBeInstanceOf(SourceNotFound);
    rt.dispose();
  });

  test("registry file lands under the Hive home; the agent-kit Ledger is untouched", async () => {
    const ledger = join(root, "agent-kit", "manifest.json");
    const { svc: s, rt } = svc();
    await Effect.runPromise(s.add("https://github.com/a/b"));
    expect(existsSync(path)).toBe(true);
    // The registry write touches only sources.json, never the interop Ledger.
    expect(existsSync(ledger)).toBe(false);
    rt.dispose();
  });

  test("persistence round-trips across a fresh registry instance", async () => {
    const first = svc();
    const created = await Effect.runPromise(first.svc.add("https://github.com/a/b"));
    await Effect.runPromise(first.svc.deactivate(created.id));
    first.rt.dispose();

    expect(existsSync(path)).toBe(true);

    const second = svc();
    const list = await Effect.runPromise(second.svc.list());
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
    expect(list[0]?.active).toBe(false);
    second.rt.dispose();
  });
});

describe("SourceRegistryLive — first-run Starter seeding (#32)", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-sources-seed-"));
    path = join(root, "sources.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function svc() {
    const rt = ManagedRuntime.make(SourceRegistryLive({ mode: "file", path }));
    return { svc: rt.runSync(SourceRegistry), rt };
  }

  test("missing file → seeds exactly the local Starter (id 'starter', kind 'local', active, origin 'local:starter'); NOT my-agent-kits", async () => {
    expect(existsSync(path)).toBe(false);
    const { svc: s, rt } = svc();
    const list = await Effect.runPromise(s.list());
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(STARTER_ID);
    expect(list[0]?.origin).toBe(STARTER_ORIGIN);
    expect(list[0]?.kind).toBe("local");
    expect(list[0]?.active).toBe(true);
    // No remote my-agent-kits seed anymore.
    expect(list.some((x) => x.origin.includes("my-agent-kits"))).toBe(false);
    // currentSources() returns the in-memory list synchronously, matching list().
    expect(s.currentSources().map((x) => x.id)).toEqual(list.map((x) => x.id));
    expect(existsSync(path)).toBe(true); // seeded + persisted
    rt.dispose();
  });

  test("first-run seed emits NO source.added audit event; a real user add still does", async () => {
    const seen: Array<{ id: string; origin: string }> = [];
    const { svc: s, rt } = svc();
    s.events.on("source.added", (e) => {
      seen.push(e);
    });
    // The Starter was seeded during the Layer build via the store-level seedLocal,
    // which is OFF the audited service `add()` path — so no event fired then, and
    // none fires on a subsequent read.
    const list = await Effect.runPromise(s.list());
    expect(list[0]?.id).toBe(STARTER_ID);
    expect(seen).toHaveLength(0);
    // A genuine user add DOES emit — proving the spy is wired and the zero above is
    // meaningful, not a dead listener.
    await Effect.runPromise(s.add("https://github.com/owner/added"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe("https://github.com/owner/added");
    rt.dispose();
  });

  test("exists-but-empty file (`{version,sources:[]}`) → NO re-seed", async () => {
    writeFileSync(path, JSON.stringify({ version: SOURCES_FILE_VERSION, sources: [] }), "utf8");
    const { svc: s, rt } = svc();
    expect(await Effect.runPromise(s.list())).toHaveLength(0);
    rt.dispose();
  });

  test("a STALE-version file (discarded as EMPTY) RE-SEEDS the Starter — no empty-registry boot", async () => {
    // A prior-schema v1 file present on disk: read() discards it as EMPTY, and the
    // seed gate (isCurrentVersion, not bare exists) must still re-seed the Starter.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sources: [{ id: "old", origin: "https://github.com/a/b", active: true, createdAt: 1 }],
      }),
      "utf8",
    );
    const { svc: s, rt } = svc();
    const list = await Effect.runPromise(s.list());
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(STARTER_ID);
    expect(list[0]?.kind).toBe("local");
    rt.dispose();
  });

  test("deleting the Starter then re-constructing does NOT re-seed", async () => {
    // First run seeds.
    const first = svc();
    const list = await Effect.runPromise(first.svc.list());
    const seeded = list[0];
    expect(seeded).toBeDefined();
    if (!seeded) throw new Error("setup failed");
    await Effect.runPromise(first.svc.delete(seeded.id));
    first.rt.dispose();

    // The file now exists with sources:[] — a re-construct must NOT re-seed.
    const second = svc();
    expect(await Effect.runPromise(second.svc.list())).toHaveLength(0);
    second.rt.dispose();
  });

  test("currentSources() returns the in-memory list synchronously", async () => {
    const { svc: s, rt } = svc();
    const fromList = await Effect.runPromise(s.list());
    expect(s.currentSources()).toEqual(fromList);
    rt.dispose();
  });
});

describe("SourceRegistryLive — memory mode writes no file", () => {
  let root: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-sources-mem-"));
    // Point the Hive home at the temp dir so any stray write would be detectable.
    prevRoot = process.env.HIVE_RUNTIME_ROOT;
    process.env.HIVE_RUNTIME_ROOT = root;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.HIVE_RUNTIME_ROOT;
    else process.env.HIVE_RUNTIME_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  test("memory-mode full lifecycle writes NO file under the Hive home", async () => {
    const rt = ManagedRuntime.make(SourceRegistryLive({ mode: "memory" }));
    const s = rt.runSync(SourceRegistry);

    // Memory mode never seeds the default Source.
    expect(await Effect.runPromise(s.list())).toHaveLength(0);

    const created = await Effect.runPromise(s.add("https://github.com/a/b"));
    await Effect.runPromise(s.deactivate(created.id));
    await Effect.runPromise(s.activate(created.id));
    const dup = await Effect.runPromise(Effect.flip(s.add("https://github.com/a/b")));
    expect(dup).toBeInstanceOf(DuplicateOrigin);
    await Effect.runPromise(s.delete(created.id));
    expect(await Effect.runPromise(s.list())).toHaveLength(0);

    expect(existsSync(join(root, "sources.json"))).toBe(false);
    rt.dispose();
  });
});
