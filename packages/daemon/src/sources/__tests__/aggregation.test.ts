import { describe, expect, test } from "bun:test";
import type { Source } from "@hive/contract";
import { type AggInput, aggregate, sourcePrecedence } from "../aggregation.ts";

function src(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    origin: `https://github.com/owner/${id}`,
    kind: "git",
    active: true,
    createdAt: 0,
    ...over,
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
  test("git outranks local (Starter)", () => {
    const rank = sourcePrecedence([src("starter", { kind: "local" }), src("git1")]);
    expect((rank.get("git1") ?? -1) > (rank.get("starter") ?? -1)).toBe(true);
  });

  test("among git Sources, the later insertion index wins (NOT createdAt)", () => {
    const rank = sourcePrecedence([src("first"), src("second"), src("third")]);
    expect((rank.get("third") ?? -1) > (rank.get("second") ?? -1)).toBe(true);
    expect((rank.get("second") ?? -1) > (rank.get("first") ?? -1)).toBe(true);
  });

  test("equal createdAt: the later-inserted Source still wins deterministically", () => {
    const rank = sourcePrecedence([src("a", { createdAt: 100 }), src("b", { createdAt: 100 })]);
    expect((rank.get("b") ?? -1) > (rank.get("a") ?? -1)).toBe(true);
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
});
