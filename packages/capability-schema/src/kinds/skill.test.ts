import { describe, expect, test } from "bun:test";
import { assertNameMatchesDir, SkillFrontmatter } from "../index.ts";

const VALID = {
  name: "pdf-extractor",
  description: "Extracts text and tables from PDF files in third person.",
};

describe("SkillFrontmatter — valid fixtures (lenient superset)", () => {
  test("minimal required fields pass", () => {
    expect(SkillFrontmatter.safeParse(VALID).success).toBe(true);
  });

  test("all optional fields pass", () => {
    const full = {
      ...VALID,
      license: "MIT",
      compatibility: "Claude Code >= 1.0",
      metadata: { version: "1.0", author: "team" },
      "allowed-tools": "Read Write Bash",
    };
    expect(SkillFrontmatter.safeParse(full).success).toBe(true);
  });

  test("name optional — description-only passes", () => {
    expect(SkillFrontmatter.safeParse({ description: VALID.description }).success).toBe(true);
  });

  test("name null (bare `name:` left blank) passes — treated like absent", () => {
    expect(SkillFrontmatter.safeParse({ description: VALID.description, name: null }).success).toBe(true);
  });

  test("name-less skill with an extra unknown key passes", () => {
    const result = SkillFrontmatter.safeParse({ description: VALID.description, added_in: "0.1.0" });
    expect(result.success).toBe(true);
  });

  test("unknown frontmatter key passes (passthrough)", () => {
    expect(SkillFrontmatter.safeParse({ ...VALID, version: "1.0" }).success).toBe(true);
  });

  test("allowed_tools underscore key passes (passthrough)", () => {
    expect(SkillFrontmatter.safeParse({ ...VALID, allowed_tools: "Read Write" }).success).toBe(true);
  });

  test("unknown keys are PRESERVED on the parsed object (passthrough, not stripped)", () => {
    const result = SkillFrontmatter.safeParse({ ...VALID, added_in: "0.1.0", upstream: "x" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Index into the passthrough record without `any`/casts.
    const data: Record<string, unknown> = result.data;
    expect(data.added_in).toBe("0.1.0");
    expect(data.upstream).toBe("x");
  });

  test("metadata accepts non-string scalar values (true superset)", () => {
    expect(SkillFrontmatter.safeParse({ ...VALID, metadata: { reviewed: 1 } }).success).toBe(true);
    expect(SkillFrontmatter.safeParse({ ...VALID, metadata: { stable: true } }).success).toBe(true);
  });
});

describe("SkillFrontmatter — one invalid case per rule", () => {
  function rejects(obj: unknown): boolean {
    return !SkillFrontmatter.safeParse(obj).success;
  }

  test("missing description", () => {
    expect(rejects({ name: VALID.name })).toBe(true);
  });

  test("a present but malformed name still rejects (even with description)", () => {
    expect(rejects({ description: VALID.description, name: "Bad-NAME" })).toBe(true);
  });

  test("name too long (>64)", () => {
    expect(rejects({ ...VALID, name: "a".repeat(65) })).toBe(true);
  });

  test("uppercase name", () => {
    expect(rejects({ ...VALID, name: "PdfExtractor" })).toBe(true);
  });

  test("leading hyphen", () => {
    expect(rejects({ ...VALID, name: "-pdf" })).toBe(true);
  });

  test("trailing hyphen", () => {
    expect(rejects({ ...VALID, name: "pdf-" })).toBe(true);
  });

  test("consecutive hyphen", () => {
    expect(rejects({ ...VALID, name: "pdf--extractor" })).toBe(true);
  });

  test("name containing 'claude' (case-insensitive)", () => {
    expect(rejects({ ...VALID, name: "claude-helper" })).toBe(true);
    expect(rejects({ ...VALID, name: "my-claude-thing" })).toBe(true);
  });

  test("name containing 'anthropic' (case-insensitive)", () => {
    expect(rejects({ ...VALID, name: "anthropic-tool" })).toBe(true);
  });

  test("name with XML-tag characters (< or >)", () => {
    // The chars also fail the regex, but the superRefine guards them explicitly;
    // a name that passes the regex but contains these would still be rejected.
    expect(rejects({ ...VALID, name: "a<b" })).toBe(true);
    expect(rejects({ ...VALID, name: "a>b" })).toBe(true);
  });

  test("empty description", () => {
    expect(rejects({ ...VALID, description: "" })).toBe(true);
  });

  test("description >1024", () => {
    expect(rejects({ ...VALID, description: "x".repeat(1025) })).toBe(true);
  });

  test("compatibility >500", () => {
    expect(rejects({ ...VALID, compatibility: "x".repeat(501) })).toBe(true);
  });
});

describe("assertNameMatchesDir", () => {
  test("passes when name equals parent dir", () => {
    expect(() => assertNameMatchesDir("pdf-extractor", "pdf-extractor")).not.toThrow();
  });

  test("throws when name differs from parent dir", () => {
    expect(() => assertNameMatchesDir("pdf-extractor", "pdf")).toThrow();
  });
});
