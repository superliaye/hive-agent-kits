import { describe, expect, test } from "bun:test";
import { assertNameMatchesDir, SkillFrontmatter } from "../index.ts";

const VALID = {
  name: "pdf-extractor",
  description: "Extracts text and tables from PDF files in third person.",
};

describe("SkillFrontmatter — valid fixtures", () => {
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
});

describe("SkillFrontmatter — one invalid case per rule", () => {
  function rejects(obj: unknown): boolean {
    return !SkillFrontmatter.safeParse(obj).success;
  }

  test("missing name", () => {
    expect(rejects({ description: VALID.description })).toBe(true);
  });

  test("missing description", () => {
    expect(rejects({ name: VALID.name })).toBe(true);
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

  test("unknown frontmatter key (strict reject)", () => {
    expect(rejects({ ...VALID, version: "1.0" })).toBe(true);
  });

  test("allowed_tools underscore key (strict reject)", () => {
    expect(rejects({ ...VALID, allowed_tools: "Read Write" })).toBe(true);
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
