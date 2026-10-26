import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SOURCES_FILE_VERSION, type SourcesAuditEvents } from "../../types.ts";
import { DuplicateOrigin, SourceNotFound } from "../errors.ts";
import { DEV_FIXTURE_SOURCES, SourceRegistry, SourceRegistryLive } from "../sources-live.ts";

const FIXTURE_IDS = DEV_FIXTURE_SOURCES.map((seed) => seed.id);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gitInput(repoUrl: string) {
  return {
    label: repoUrl,
    locator: {
      kind: "git" as const,
      repoUrl,
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    },
  };
}

describe("SourceRegistryLive — file mode lifecycle", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-sources-live-"));
    path = join(root, "sources.json");
    // These tests exercise the lifecycle verbs in isolation, not first-run
    // seeding: write an empty file so the `!persist.exists()` seed gate is skipped
    // (seeding has its own describe block below).
    writeFileSync(
      path,
      JSON.stringify({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] }),
      "utf8",
    );
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
    const created = await Effect.runPromise(s.add(gitInput(origin)));
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
    await Effect.runPromise(s.add(gitInput("https://github.com/a/b")));

    const dupPlain = await Effect.runPromise(
      Effect.flip(s.add(gitInput("https://github.com/a/b"))),
    );
    expect(dupPlain).toBeInstanceOf(DuplicateOrigin);

    const dupGit = await Effect.runPromise(
      Effect.flip(s.add(gitInput("https://github.com/a/b.git"))),
    );
    expect(dupGit).toBeInstanceOf(DuplicateOrigin);

    const dupSlash = await Effect.runPromise(
      Effect.flip(s.add(gitInput("https://github.com/a/b/"))),
    );
    expect(dupSlash).toBeInstanceOf(DuplicateOrigin);

    expect(await Effect.runPromise(s.list())).toHaveLength(1);
    rt.dispose();
  });

  test("audit failure prevents a Source add from committing in memory or on disk", async () => {
    const first = svc();
    first.svc.events.on("source.added", () => {
      throw new Error("audit unavailable");
    });

    await expect(
      Effect.runPromise(first.svc.add(gitInput("https://github.com/a/b"))),
    ).rejects.toThrow("audit unavailable");
    expect(await Effect.runPromise(first.svc.list())).toEqual([]);
    await first.rt.dispose();

    const reopened = svc();
    expect(await Effect.runPromise(reopened.svc.list())).toEqual([]);
    await reopened.rt.dispose();
  });

  test("deactivate → active:false; activate → active:true", async () => {
    const { svc: s, rt } = svc();
    const created = await Effect.runPromise(s.add(gitInput("https://github.com/a/b")));

    const off = await Effect.runPromise(s.deactivate(created.id));
    expect(off.active).toBe(false);

    const on = await Effect.runPromise(s.activate(created.id));
    expect(on.active).toBe(true);
    rt.dispose();
  });

  test("delete → gone", async () => {
    const { svc: s, rt } = svc();
    const created = await Effect.runPromise(s.add(gitInput("https://github.com/a/b")));
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
    await Effect.runPromise(s.add(gitInput("https://github.com/a/b")));
    expect(existsSync(path)).toBe(true);
    // The registry write touches only sources.json, never the interop Ledger.
    expect(existsSync(ledger)).toBe(false);
    rt.dispose();
  });

  test("persistence round-trips across a fresh registry instance", async () => {
    const first = svc();
    const created = await Effect.runPromise(first.svc.add(gitInput("https://github.com/a/b")));
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

describe("SourceRegistryLive — first run", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-sources-seed-"));
    path = join(root, "sources.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function svc(seedFixtureSources = false) {
    const rt = ManagedRuntime.make(SourceRegistryLive({ mode: "file", path, seedFixtureSources }));
    return { svc: rt.runSync(SourceRegistry), rt };
  }

  test("a fresh install starts with no Sources: no Starter and no my-agent-kits", async () => {
    expect(existsSync(path)).toBe(false);
    const { svc: s, rt } = svc();
    expect(await Effect.runPromise(s.list())).toEqual([]);
    expect(s.currentSources()).toEqual([]);
    rt.dispose();
  });

  test("dev fixture mode seeds the fixture Sources with NO source.added event; a user add still emits", async () => {
    const seen: SourcesAuditEvents["source.added"][] = [];
    const { svc: s, rt } = svc(true);
    s.events.on("source.added", (e) => {
      seen.push(e);
    });
    // Seeded during the Layer build via the store-level seedLocal, which is OFF
    // the audited service `add()` path — so no event fired then, and none fires
    // on a subsequent read.
    const list = await Effect.runPromise(s.list());
    expect(list.map((x) => [x.id, x.kind, x.active])).toEqual(
      FIXTURE_IDS.map((id) => [id, "local", true]),
    );
    expect(existsSync(path)).toBe(true);
    expect(seen).toHaveLength(0);
    // A genuine user add DOES emit — proving the spy is wired and the zero above is
    // meaningful, not a dead listener.
    await Effect.runPromise(s.add(gitInput("https://github.com/owner/added")));
    expect(seen).toEqual([
      { id: expect.any(String), kind: "git", origin: "https://github.com/owner/added", tile: null },
    ]);
    rt.dispose();
  });

  test("exists-but-empty file (`{version,sources:[]}`) → NO re-seed", async () => {
    writeFileSync(
      path,
      JSON.stringify({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] }),
      "utf8",
    );
    const { svc: s, rt } = svc(true);
    expect(await Effect.runPromise(s.list())).toHaveLength(0);
    rt.dispose();
  });

  test("a STALE-version file (discarded as EMPTY) re-seeds the fixtures — no empty fixture boot", async () => {
    // A prior-schema v1 file present on disk: read() discards it as EMPTY, and the
    // seed gate (isCurrentVersion, not bare exists) must still re-seed.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sources: [{ id: "old", origin: "https://github.com/a/b", active: true, createdAt: 1 }],
      }),
      "utf8",
    );
    const { svc: s, rt } = svc(true);
    expect((await Effect.runPromise(s.list())).map((x) => x.id)).toEqual([...FIXTURE_IDS]);
    rt.dispose();
  });

  test("deleting the fixtures then re-constructing does NOT re-seed", async () => {
    const first = svc(true);
    for (const id of FIXTURE_IDS) await Effect.runPromise(first.svc.delete(id));
    first.rt.dispose();

    // The file now exists with sources:[] — a re-construct must NOT re-seed.
    const second = svc(true);
    expect(await Effect.runPromise(second.svc.list())).toHaveLength(0);
    second.rt.dispose();
  });

  test("currentSources() returns the in-memory list synchronously", async () => {
    const { svc: s, rt } = svc(true);
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

    const created = await Effect.runPromise(s.add(gitInput("https://github.com/a/b")));
    await Effect.runPromise(s.deactivate(created.id));
    await Effect.runPromise(s.activate(created.id));
    const dup = await Effect.runPromise(Effect.flip(s.add(gitInput("https://github.com/a/b"))));
    expect(dup).toBeInstanceOf(DuplicateOrigin);
    await Effect.runPromise(s.delete(created.id));
    expect(await Effect.runPromise(s.list())).toHaveLength(0);

    expect(existsSync(join(root, "sources.json"))).toBe(false);
    rt.dispose();
  });
});
