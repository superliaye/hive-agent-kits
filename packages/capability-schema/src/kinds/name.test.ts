import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertNameMatchesDir, NAME_PATTERN, refineName } from "../index.ts";

describe("NAME_PATTERN", () => {
  test("accepts lowercase alnum with single hyphens", () => {
    expect(NAME_PATTERN.test("pdf-extractor")).toBe(true);
    expect(NAME_PATTERN.test("a1")).toBe(true);
  });

  test("rejects uppercase, leading/trailing/consecutive hyphens", () => {
    expect(NAME_PATTERN.test("PdfExtractor")).toBe(false);
    expect(NAME_PATTERN.test("-pdf")).toBe(false);
    expect(NAME_PATTERN.test("pdf-")).toBe(false);
    expect(NAME_PATTERN.test("pdf--x")).toBe(false);
  });
});

describe("refineName (reusable superRefine body)", () => {
  // A minimal passthrough schema that wires only refineName, so the guard is
  // tested in isolation from any kind's other rules.
  const NameOnly = z.object({ name: z.string().optional() }).passthrough().superRefine(refineName);

  test("a present valid name passes", () => {
    expect(NameOnly.safeParse({ name: "good-name" }).success).toBe(true);
  });

  test("an absent name passes (deferred to the directory, not refined)", () => {
    expect(NameOnly.safeParse({}).success).toBe(true);
  });

  test("XML-tag characters in the name are rejected", () => {
    expect(NameOnly.safeParse({ name: "a<b" }).success).toBe(false);
    expect(NameOnly.safeParse({ name: "a>b" }).success).toBe(false);
  });

  test("reserved words anthropic/claude (case-insensitive) are rejected", () => {
    expect(NameOnly.safeParse({ name: "claude-helper" }).success).toBe(false);
    expect(NameOnly.safeParse({ name: "My-Anthropic" }).success).toBe(false);
  });
});

describe("assertNameMatchesDir (required kind label)", () => {
  test("passes when name equals parent dir", () => {
    expect(() => assertNameMatchesDir("foo", "foo", "agent")).not.toThrow();
  });

  test("throws naming the kind when name differs", () => {
    expect(() => assertNameMatchesDir("foo", "bar", "agent")).toThrow(/agent name "foo"/);
    expect(() => assertNameMatchesDir("foo", "bar", "skill")).toThrow(/skill name "foo"/);
  });
});
