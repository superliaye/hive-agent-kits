import { describe, expect, test } from "bun:test";
import {
  CapabilityKey,
  CapabilityKind,
  ContentSha,
  parseCapabilityKey,
  serializeCapabilityKey,
} from "./index.ts";

const SHA64 = "a".repeat(64);

describe("ContentSha", () => {
  test("accepts a 64-hex string", () => {
    // `.parse` returns the branded value; compare its string content without a
    // cast by going through safeParse + `.data`.
    const parsed = ContentSha.safeParse(SHA64);
    expect(parsed.success).toBe(true);
    expect(String(parsed.success && parsed.data)).toBe(SHA64);
    expect(ContentSha.safeParse("0123456789abcdef".repeat(4)).success).toBe(true);
  });

  test("rejects wrong length", () => {
    expect(ContentSha.safeParse("a".repeat(63)).success).toBe(false);
    expect(ContentSha.safeParse("a".repeat(65)).success).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(ContentSha.safeParse("g".repeat(64)).success).toBe(false);
    expect(ContentSha.safeParse("A".repeat(64)).success).toBe(false); // uppercase
  });
});

describe("CapabilityKind", () => {
  test("accepts the five kinds", () => {
    for (const k of ["instruction", "skill", "agent", "plugin", "bundle"]) {
      expect(CapabilityKind.safeParse(k).success).toBe(true);
    }
  });

  test("rejects an unknown kind", () => {
    expect(CapabilityKind.safeParse("snippet").success).toBe(false);
  });
});

describe("CapabilityKey serialize/parse", () => {
  test("round-trips to `${kind}:${name}`", () => {
    const key = CapabilityKey.parse({ kind: "skill", name: "my-skill" });
    const s = serializeCapabilityKey(key);
    expect(s).toBe("skill:my-skill");
    expect(parseCapabilityKey(s)).toEqual(key);
  });

  test("parse rejects a malformed string (no colon)", () => {
    expect(() => parseCapabilityKey("skillmy-skill")).toThrow();
  });

  test("parse rejects a bad kind", () => {
    expect(() => parseCapabilityKey("snippet:x")).toThrow();
  });

  test("parse rejects a name containing a path separator", () => {
    expect(() => parseCapabilityKey("skill:a/b")).toThrow();
    expect(() => parseCapabilityKey("skill:a\\b")).toThrow();
  });

  test("CapabilityKey rejects a path-separator, colon, or dot-leading name directly", () => {
    expect(CapabilityKey.safeParse({ kind: "skill", name: "a/b" }).success).toBe(false);
    expect(CapabilityKey.safeParse({ kind: "skill", name: "a\\b" }).success).toBe(false);
    expect(CapabilityKey.safeParse({ kind: "skill", name: "a:b" }).success).toBe(false);
    expect(CapabilityKey.safeParse({ kind: "skill", name: ".hidden" }).success).toBe(false);
    expect(CapabilityKey.safeParse({ kind: "skill", name: "" }).success).toBe(false);
  });

  test("parse rejects an empty or colon-prefixed name", () => {
    expect(() => parseCapabilityKey("skill:")).toThrow();
    expect(() => parseCapabilityKey("skill::foo")).toThrow();
  });
});
