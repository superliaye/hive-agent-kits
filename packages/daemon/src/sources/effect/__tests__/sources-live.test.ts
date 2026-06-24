import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { DuplicateOrigin, SourceNotFound } from "../errors.ts";
import { SourceRegistry, SourceRegistryLive } from "../sources-live.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("SourceRegistryLive — file mode lifecycle", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-sources-live-"));
    path = join(root, "sources.json");
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
