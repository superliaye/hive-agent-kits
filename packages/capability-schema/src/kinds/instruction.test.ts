import { describe, expect, test } from "bun:test";
import { InstructionFrontmatter } from "../index.ts";

const VALID = {
  description: "Core repo-agnostic conduct rules.",
};

describe("InstructionFrontmatter — valid fixtures (lenient superset)", () => {
  test("minimal required field (description only) passes", () => {
    expect(InstructionFrontmatter.safeParse(VALID).success).toBe(true);
  });

  test("unknown keys ride through (passthrough) and are preserved", () => {
    const result = InstructionFrontmatter.safeParse({
      ...VALID,
      applyTo: "**",
      added_in: "0.1.0",
      derived_from: "https://example.com/x",
      synced: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data: Record<string, unknown> = result.data;
    expect(data.applyTo).toBe("**");
    expect(data.synced).toBe(false);
  });

  // Reference-content regression guard (inline; the exhaustive fs-driven guard over
  // ALL clone instructions lives in schema-tools validate.test.ts).
  test("reference: core.instructions.md", () => {
    const fm = {
      description:
        "Core repo-agnostic conduct rules — evergreen docs, ask before git mutations, research current-state claims",
      applyTo: "**",
      added_in: "0.1.0",
    };
    expect(InstructionFrontmatter.safeParse(fm).success).toBe(true);
  });

  test("reference: karpathy.instructions.md (derived_from + synced)", () => {
    const fm = {
      description:
        "Karpathy's behavioral guidelines for LLM-assisted coding (Think before, simplicity, surgical, goal-driven)",
      applyTo: "**",
      added_in: "0.2.1",
      derived_from: "https://github.com/forrestchang/andrej-karpathy-skills",
      synced: false,
    };
    expect(InstructionFrontmatter.safeParse(fm).success).toBe(true);
  });
});

describe("InstructionFrontmatter — one invalid case per rule", () => {
  function rejects(obj: unknown): boolean {
    return !InstructionFrontmatter.safeParse(obj).success;
  }

  test("missing description", () => {
    expect(rejects({ applyTo: "**" })).toBe(true);
  });

  test("empty description", () => {
    expect(rejects({ description: "" })).toBe(true);
  });
});
