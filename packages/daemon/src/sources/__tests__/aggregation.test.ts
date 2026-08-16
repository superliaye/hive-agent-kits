import { describe, expect, test } from "bun:test";
import type { Source } from "@hive/contract";
import { type AggInput, aggregate, sourcePrecedence } from "../aggregation.ts";

// Default rank derives from a per-call counter so successive `src()` fixtures get
// increasing ranks (mirroring the seed: each later-added Source = the new highest
// rank). Pass `rank` in `over` to pin a specific precedence (e.g. a re-rank).
let rankSeq = 0;
function src(id: string, over: Partial<Source> = {}): Source {
  const origin = over.origin ?? `https://github.com/owner/${id}`;
  return {
    ...over,
    id,
    label: over.label ?? id,
    locator:
      over.locator ??
      ({
        kind: "git",
        repoUrl: origin,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      } as const),
    origin,
    kind: over.kind ?? "git",
    active: over.active ?? true,
    createdAt: over.createdAt ?? 0,
    rank: over.rank ?? rankSeq++,
  };
}

function input(over: Partial<AggInput> & Pick<AggInput, "name" | "sourceId">): AggInput {
  return {
    kind: "skill",
    description: "",
    group: "",
    contentSha: "a".repeat(64),
    resolvable: true,
    ...over,
  };
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("sourcePrecedence", () => {
  test("reads the stored rank directly (higher wins), independent of array order", () => {
    // The git Source carries a LOWER rank than the local Starter here — a FREE total
    // order, so the precedence map must honor the stored rank, not a kind-band.
    const rank = sourcePrecedence([
      src("git1", { kind: "git", rank: 1 }),
      src("starter", { kind: "local", rank: 5 }),
    ]);
    expect(rank.get("git1")).toBe(1);
    expect(rank.get("starter")).toBe(5);
    expect((rank.get("starter") ?? -1) > (rank.get("git1") ?? -1)).toBe(true);
  });

  test("default seed ranks reproduce git > local Starter (Starter lowest, each add higher)", () => {
    // Seed order: Starter first (lowest), then two git adds (each the new highest).
    const rank = sourcePrecedence([
      src("starter", { kind: "local", rank: 0 }),
      src("git1", { rank: 1 }),
      src("git2", { rank: 2 }),
    ]);
    expect((rank.get("git2") ?? -1) > (rank.get("git1") ?? -1)).toBe(true);
    expect((rank.get("git1") ?? -1) > (rank.get("starter") ?? -1)).toBe(true);
  });

  test("NOT derived from array index — the same set in a different order maps identically", () => {
    const a = sourcePrecedence([src("x", { rank: 7 }), src("y", { rank: 3 })]);
    const b = sourcePrecedence([src("y", { rank: 3 }), src("x", { rank: 7 })]);
    expect(a.get("x")).toBe(b.get("x"));
    expect(a.get("y")).toBe(b.get("y"));
    expect(a.get("x")).toBe(7);
    expect(a.get("y")).toBe(3);
  });
});

describe("aggregate", () => {
  const rank = (sources: Source[]) => sourcePrecedence(sources);

  test("(a) MERGE: same key, same ContentSha -> ONE entry, sourceIds winner-first", () => {
    const sources = [src("s1"), src("s2")];
    const entries = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_A }),
      ],
      rank(sources),
    );
    expect(entries.length).toBe(1);
    const foo = entries[0];
    expect(foo?.deployable).toBe(true);
    expect(foo?.shadowed).toBe(false);
    // s2 inserted later → higher rank → winner-first.
    expect(foo?.sourceIds).toEqual(["s2", "s1"]);
  });

  test("(b) COLLISION: same key, different ContentSha -> TWO entries, winner + shadow", () => {
    const sources = [src("s1"), src("s2")];
    const entries = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_B }),
      ],
      rank(sources),
    );
    expect(entries.length).toBe(2);
    const deployable = entries.filter((e) => e.deployable);
    const shadowed = entries.filter((e) => e.shadowed);
    expect(deployable.length).toBe(1);
    expect(shadowed.length).toBe(1);
    expect(deployable[0]?.sourceIds[0]).toBe("s2"); // later git wins
    expect(shadowed[0]?.deployable).toBe(false);
  });

  test("(c) precedence picks the winner across >=2 losing variants", () => {
    const sources = [src("s1"), src("s2"), src("s3")];
    const entries = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_B }),
        input({ name: "foo", sourceId: "s3", contentSha: SHA_C }),
      ],
      rank(sources),
    );
    expect(entries.length).toBe(3);
    const winner = entries.find((e) => e.deployable);
    expect(winner?.sourceIds[0]).toBe("s3");
    expect(entries.filter((e) => e.shadowed).length).toBe(2);
  });

  test("(d) a non-resolvable input passes through deployable:false/shadowed:false with its reason", () => {
    const entries = aggregate(
      [
        input({
          name: "bad",
          sourceId: "s1",
          resolvable: false,
          blockedReason: "duplicate leaf name within kind",
        }),
      ],
      rank([src("s1")]),
    );
    expect(entries.length).toBe(1);
    expect(entries[0]?.deployable).toBe(false);
    expect(entries[0]?.shadowed).toBe(false);
    expect(entries[0]?.blockedReason).toBe("duplicate leaf name within kind");
  });

  test("(e) entry-count conservation: {A,A,B} -> 2 entries; {A,B,C} -> 3 entries", () => {
    // s1=B (lowest rank), s2=A, s3=A — the merged {s2,s3} variant contains the
    // highest-rank Source (s3), so the merge wins and B is shadowed.
    const aab = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_B }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s3", contentSha: SHA_A }),
      ],
      rank([src("s1"), src("s2"), src("s3")]),
    );
    expect(aab.length).toBe(2);
    const merged = aab.find((e) => e.deployable && e.sourceIds.length === 2);
    expect(merged).toBeDefined();
    expect(merged?.sourceIds).toEqual(["s3", "s2"]);
    expect(aab.filter((e) => e.shadowed).length).toBe(1);

    const abc = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_B }),
        input({ name: "foo", sourceId: "s3", contentSha: SHA_C }),
      ],
      rank([src("s1"), src("s2"), src("s3")]),
    );
    expect(abc.length).toBe(3);
    expect(abc.filter((e) => e.deployable).length).toBe(1);
    expect(abc.filter((e) => e.shadowed).length).toBe(2);
  });

  test("(f) null-ContentSha never wins: a null from the highest-rank Source is blocked, not deployable", () => {
    // s2 is the highest-rank Source but its bytes are missing (null ContentSha).
    const entries = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: null }),
      ],
      rank([src("s1"), src("s2")]),
    );
    // s1 wins (the only real-content variant); s2 is a blocked pass-through.
    const winner = entries.find((e) => e.deployable);
    expect(winner?.sourceIds).toEqual(["s1"]);
    const blocked = entries.find((e) => e.sourceIds.includes("s2"));
    expect(blocked?.deployable).toBe(false);
    expect(blocked?.shadowed).toBe(false);
  });

  test("(g) one-variant-per-Source invariant: a Source in two variants of one key throws", () => {
    expect(() =>
      aggregate(
        [
          input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
          input({ name: "foo", sourceId: "s1", contentSha: SHA_B }),
        ],
        rank([src("s1")]),
      ),
    ).toThrow();
  });

  test("(h) shadowedBy on the shadowed variant = the winner's top provider; winner has none", () => {
    const sources = [src("s1", { rank: 1 }), src("s2", { rank: 2 })];
    const entries = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_B }),
      ],
      rank(sources),
    );
    const winner = entries.find((e) => e.deployable);
    const shadow = entries.find((e) => e.shadowed);
    expect(winner?.sourceIds[0]).toBe("s2");
    expect(winner?.shadowedBy).toBeUndefined();
    // The shadowed variant names the deployable winner's top provider.
    expect(shadow?.shadowedBy).toBe("s2");
  });

  test("(i) a reorder that RAISES the shadowed Source above the winner FLIPS deployable/shadowed/shadowedBy", () => {
    // Before: s2 (rank 2) wins SHA_B; s1 (rank 1) is shadowed → shadowedBy s2.
    const before = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_B }),
      ],
      sourcePrecedence([src("s1", { rank: 1 }), src("s2", { rank: 2 })]),
    );
    expect(before.find((e) => e.deployable)?.sourceIds[0]).toBe("s2");
    expect(before.find((e) => e.shadowed)?.shadowedBy).toBe("s2");

    // After a reorder that swaps ranks (s1 now highest), s1's variant wins and s2
    // becomes shadowed → shadowedBy now points at s1.
    const after = aggregate(
      [
        input({ name: "foo", sourceId: "s1", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "s2", contentSha: SHA_B }),
      ],
      sourcePrecedence([src("s1", { rank: 2 }), src("s2", { rank: 1 })]),
    );
    const winner = after.find((e) => e.deployable);
    const shadow = after.find((e) => e.shadowed);
    expect(winner?.sourceIds[0]).toBe("s1");
    expect(winner?.shadowedBy).toBeUndefined();
    expect(shadow?.sourceIds[0]).toBe("s2");
    expect(shadow?.shadowedBy).toBe("s1");
  });

  test("(j) a FREE reorder may place the local Starter above a git Source (band-crossing allowed)", () => {
    // Starter (local) carries a HIGHER rank than the git Source — a deliberate
    // re-rank across what used to be a hard kind-band. The Starter's variant wins.
    const entries = aggregate(
      [
        input({ name: "foo", sourceId: "starter", contentSha: SHA_A }),
        input({ name: "foo", sourceId: "git1", contentSha: SHA_B }),
      ],
      sourcePrecedence([
        src("starter", { kind: "local", rank: 9 }),
        src("git1", { kind: "git", rank: 2 }),
      ]),
    );
    const winner = entries.find((e) => e.deployable);
    const shadow = entries.find((e) => e.shadowed);
    expect(winner?.sourceIds[0]).toBe("starter");
    expect(shadow?.sourceIds[0]).toBe("git1");
    expect(shadow?.shadowedBy).toBe("starter");
  });
});
