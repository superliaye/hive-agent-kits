import { describe, expect, test } from "bun:test";
import { createSourcesStore, type SourcesWriter } from "../store.ts";
import { locatorIdentity, normalizeOrigin, SOURCES_FILE_VERSION } from "../types.ts";

const universeLocator = {
  kind: "git" as const,
  repoUrl: "https://github.com/databricks-eng/universe",
  revision: { mode: "track" as const, ref: "refs/heads/master" },
  subpath: "experimental/leon-ye_data/agent-kits",
};

function gitInput(repoUrl: string) {
  return {
    label: normalizeOrigin(repoUrl),
    locator: {
      kind: "git" as const,
      repoUrl,
      revision: { mode: "track" as const, ref: "refs/heads/main" },
      subpath: ".",
    },
  };
}

describe("locator identity", () => {
  test("allows two subpaths or revisions from the same repository", () => {
    expect(locatorIdentity(universeLocator)).not.toBe(
      locatorIdentity({ ...universeLocator, subpath: "experimental/another/agent-kits" }),
    );
    expect(locatorIdentity(universeLocator)).not.toBe(
      locatorIdentity({
        ...universeLocator,
        revision: { mode: "pin", commit: "a".repeat(40) },
      }),
    );
  });
});

describe("createSourcesStore — locator authority", () => {
  test("deduplicates the full locator and increments registry revision", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    const added = store.add({ label: "Personal kit", locator: universeLocator });
    expect(added.ok).toBe(true);
    expect(store.snapshot().revision).toBe(1);
    expect(store.add({ label: "Duplicate label", locator: universeLocator })).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(
      store.add({
        label: "Other subpath",
        locator: { ...universeLocator, subpath: "experimental/other/agent-kits" },
      }).ok,
    ).toBe(true);
  });

  test("isolates locator input and returned Sources from registry state", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    const input = {
      label: "Personal kit",
      locator: {
        kind: "git" as const,
        repoUrl: "https://github.com/databricks-eng/universe",
        revision: { mode: "track" as const, ref: "refs/heads/master" },
        subpath: "experimental/leon-ye_data/agent-kits",
      },
    };
    const added = store.add(input);
    if (
      !added.ok ||
      added.source.locator.kind !== "git" ||
      added.source.locator.revision.mode !== "track"
    ) {
      throw new Error("setup failed");
    }

    input.locator.repoUrl = "https://github.com/attacker/input";
    added.source.locator.revision.ref = "refs/heads/attacker-result";

    const listed = store.list();
    const firstListed = listed[0];
    if (firstListed?.locator.kind !== "git") throw new Error("setup failed");
    firstListed.locator.subpath = "attacker/list";

    const snap = store.snapshot();
    const firstSnap = snap.sources[0];
    if (firstSnap?.locator.kind !== "git") throw new Error("setup failed");
    firstSnap.locator.repoUrl = "https://github.com/attacker/snapshot";

    const deactivated = store.deactivate(added.source.id);
    if (!deactivated.ok || deactivated.source.locator.kind !== "git")
      throw new Error("setup failed");
    deactivated.source.locator.subpath = "attacker/deactivate";

    const reordered = store.reorder(added.source.id, "up");
    if (
      !reordered.ok ||
      reordered.source.locator.kind !== "git" ||
      reordered.source.locator.revision.mode !== "track"
    ) {
      throw new Error("setup failed");
    }
    reordered.source.locator.revision.ref = "refs/heads/attacker-reorder";

    expect(store.snapshot()).toMatchObject({
      revision: 2,
      sources: [
        {
          locator: {
            kind: "git",
            repoUrl: "https://github.com/databricks-eng/universe",
            revision: { mode: "track", ref: "refs/heads/master" },
            subpath: "experimental/leon-ye_data/agent-kits",
          },
        },
      ],
    });
  });
});

describe("normalizeOrigin", () => {
  test("collapses .git, trailing slashes, and host case to one origin", () => {
    const canonical = normalizeOrigin("https://github.com/a/b");
    expect(normalizeOrigin("https://github.com/a/b/")).toBe(canonical);
    expect(normalizeOrigin("https://github.com/a/b//")).toBe(canonical);
    expect(normalizeOrigin("https://github.com/a/b.git")).toBe(canonical);
    expect(normalizeOrigin("https://github.com/a/b.git/")).toBe(canonical);
    expect(normalizeOrigin("https://GitHub.com/a/b")).toBe(canonical);
    expect(normalizeOrigin("HTTPS://github.com/a/b")).toBe(canonical);
  });

  test("preserves path case (significant on some forges)", () => {
    expect(normalizeOrigin("https://github.com/A/B")).not.toBe(
      normalizeOrigin("https://github.com/a/b"),
    );
  });

  test("does not throw on a non-URL string", () => {
    expect(() => normalizeOrigin("not a url")).not.toThrow();
  });
});

describe("createSourcesStore — duplicate detection over normalization", () => {
  test("rejects a .git / trailing-slash / case variant of an existing origin", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    expect(store.add(gitInput("https://github.com/a/b")).ok).toBe(true);
    expect(store.add(gitInput("https://github.com/a/b.git"))).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(store.add(gitInput("https://GitHub.com/a/b/"))).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(store.list()).toHaveLength(1);
  });
});

describe("createSourcesStore — public add mints a git Source", () => {
  test("add sets kind:'git'", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    const res = store.add(gitInput("https://github.com/a/b"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source.kind).toBe("git");
  });
});

describe("createSourcesStore — rank seeding (insertion order = increasing precedence)", () => {
  test("seedLocal then add: the Starter gets the LOWEST rank, each add the new highest", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    const starter = store.seedLocal("starter", "local:starter");
    const a = store.add(gitInput("https://github.com/a/b"));
    const b = store.add(gitInput("https://github.com/c/d"));
    expect(starter.ok && a.ok && b.ok).toBe(true);
    if (!starter.ok || !a.ok || !b.ok) throw new Error("setup failed");
    expect(a.source.rank).toBeGreaterThan(starter.source.rank);
    expect(b.source.rank).toBeGreaterThan(a.source.rank);
  });

  test("add into a non-empty registry assigns max(existing ranks)+1", () => {
    const store = createSourcesStore({
      version: SOURCES_FILE_VERSION,
      revision: 0,
      sources: [
        {
          id: "x",
          label: "X/Y",
          locator: {
            kind: "git",
            repoUrl: "https://github.com/x/y",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
          origin: "https://github.com/x/y",
          kind: "git",
          active: true,
          createdAt: 0,
          rank: 7,
        },
      ],
    });
    const res = store.add(gitInput("https://github.com/a/b"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source.rank).toBe(8);
  });
});

describe("createSourcesStore — reorder (adjacent rank swap)", () => {
  function seeded(): ReturnType<typeof createSourcesStore> {
    return createSourcesStore({
      version: SOURCES_FILE_VERSION,
      revision: 0,
      sources: [
        {
          id: "low",
          label: "low",
          locator: {
            kind: "git",
            repoUrl: "https://github.com/a/low",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
          origin: "https://github.com/a/low",
          kind: "git",
          active: true,
          createdAt: 0,
          rank: 0,
        },
        {
          id: "mid",
          label: "mid",
          locator: {
            kind: "git",
            repoUrl: "https://github.com/a/mid",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
          origin: "https://github.com/a/mid",
          kind: "git",
          active: true,
          createdAt: 0,
          rank: 1,
        },
        {
          id: "high",
          label: "high",
          locator: {
            kind: "git",
            repoUrl: "https://github.com/a/high",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
          origin: "https://github.com/a/high",
          kind: "git",
          active: true,
          createdAt: 0,
          rank: 2,
        },
      ],
    });
  }

  test("reorder up swaps a Source's rank with its higher neighbor", () => {
    const store = seeded();
    const res = store.reorder("low", "up");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source.id).toBe("low");
      // A genuine swap is `changed:true` (drives the audit emission).
      expect(res.changed).toBe(true);
    }
    const byId = new Map(store.list().map((s) => [s.id, s.rank]));
    // low and mid swapped: low now 1, mid now 0; high untouched.
    expect(byId.get("low")).toBe(1);
    expect(byId.get("mid")).toBe(0);
    expect(byId.get("high")).toBe(2);
  });

  test("reorder down swaps a Source's rank with its lower neighbor", () => {
    const store = seeded();
    const res = store.reorder("high", "down");
    expect(res.ok).toBe(true);
    const byId = new Map(store.list().map((s) => [s.id, s.rank]));
    expect(byId.get("high")).toBe(1);
    expect(byId.get("mid")).toBe(2);
    expect(byId.get("low")).toBe(0);
  });

  test("reorder up at the TOP is a no-op (already highest) → changed:false", () => {
    const store = seeded();
    const res = store.reorder("high", "up");
    expect(res.ok).toBe(true);
    // A no-op reports changed:false so the service emits no audit row.
    if (res.ok) expect(res.changed).toBe(false);
    const byId = new Map(store.list().map((s) => [s.id, s.rank]));
    expect(byId.get("high")).toBe(2);
    expect(byId.get("mid")).toBe(1);
    expect(byId.get("low")).toBe(0);
  });

  test("reorder down at the BOTTOM is a no-op (already lowest) → changed:false", () => {
    const store = seeded();
    const res = store.reorder("low", "down");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
    const byId = new Map(store.list().map((s) => [s.id, s.rank]));
    expect(byId.get("low")).toBe(0);
  });

  test("reorder of an unknown id → not-found", () => {
    const store = seeded();
    expect(store.reorder("nope", "up")).toEqual({ ok: false, reason: "not-found" });
  });

  test("a free reorder can place the local Starter above a git Source", () => {
    const store = createSourcesStore({
      version: SOURCES_FILE_VERSION,
      revision: 0,
      sources: [
        {
          id: "starter",
          label: "Starter",
          locator: { kind: "starter" },
          origin: "local:starter",
          kind: "local",
          active: true,
          createdAt: 0,
          rank: 0,
        },
        {
          id: "git1",
          label: "A/B",
          locator: {
            kind: "git",
            repoUrl: "https://github.com/a/b",
            revision: { mode: "track", ref: "refs/heads/main" },
            subpath: ".",
          },
          origin: "https://github.com/a/b",
          kind: "git",
          active: true,
          createdAt: 0,
          rank: 1,
        },
      ],
    });
    const res = store.reorder("starter", "up");
    expect(res.ok).toBe(true);
    const byId = new Map(store.list().map((s) => [s.id, s.rank]));
    expect((byId.get("starter") ?? -1) > (byId.get("git1") ?? -1)).toBe(true);
  });
});

describe("createSourcesStore — seedLocal (the bundled Starter)", () => {
  test("seeds a kind:'local' Source with the caller-supplied fixed id + origin", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    const res = store.seedLocal("starter", "local:starter");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source.id).toBe("starter");
      expect(res.source.origin).toBe("local:starter");
      expect(res.source.kind).toBe("local");
      expect(res.source.active).toBe(true);
    }
  });

  test("is the sole minter of id 'starter' — a second seed of that id no-ops (no duplicate row)", () => {
    const store = createSourcesStore({ version: SOURCES_FILE_VERSION, revision: 0, sources: [] });
    expect(store.seedLocal("starter", "local:starter").ok).toBe(true);
    const again = store.seedLocal("starter", "local:starter");
    expect(again).toEqual({ ok: false, reason: "duplicate-id" });
    expect(store.list()).toHaveLength(1);
  });
});

describe("createSourcesStore — write-fault atomicity", () => {
  // A persist that throws must leave the in-memory state unchanged (memory and
  // disk stay consistent), not mutate memory and diverge from disk.
  const throwingWriter: SourcesWriter = {
    write() {
      throw new Error("EACCES");
    },
  };

  test("a failed add does not append to the in-memory list", () => {
    const store = createSourcesStore(
      { version: SOURCES_FILE_VERSION, revision: 0, sources: [] },
      throwingWriter,
    );
    expect(() => store.add(gitInput("https://github.com/a/b"))).toThrow();
    expect(store.list()).toHaveLength(0);
  });

  test("a failed delete does not remove from the in-memory list", () => {
    const created = createSourcesStore({
      version: SOURCES_FILE_VERSION,
      revision: 0,
      sources: [],
    }).add(gitInput("https://github.com/a/b"));
    if (!created.ok) throw new Error("setup failed");
    const failing = createSourcesStore(
      { version: SOURCES_FILE_VERSION, revision: 0, sources: [created.source] },
      throwingWriter,
    );
    expect(() => failing.delete(created.source.id)).toThrow();
    expect(failing.list()).toHaveLength(1);
  });
});
