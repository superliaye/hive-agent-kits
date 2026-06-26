import { describe, expect, test } from "bun:test";
import { AgentFrontmatter } from "../index.ts";

const VALID = {
  name: "loop-build-agent",
  description: "Build agent for the /loop-build flow. Implements an agreed plan.",
};

describe("AgentFrontmatter — valid fixtures (lenient superset)", () => {
  test("minimal required fields pass", () => {
    expect(AgentFrontmatter.safeParse(VALID).success).toBe(true);
  });

  test("name optional — description-only passes (defers to directory)", () => {
    expect(AgentFrontmatter.safeParse({ description: VALID.description }).success).toBe(true);
  });

  test("name null (bare `name:` left blank) passes — treated like absent", () => {
    expect(AgentFrontmatter.safeParse({ description: VALID.description, name: null }).success).toBe(true);
  });

  test("unknown keys ride through (passthrough) and are preserved", () => {
    const result = AgentFrontmatter.safeParse({ ...VALID, added_in: "0.32.0", upstream: "x" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data: Record<string, unknown> = result.data;
    expect(data.added_in).toBe("0.32.0");
    expect(data.upstream).toBe("x");
  });

  // Guards Q3 (no description cap): real agent descriptions run 600+ chars.
  test("a 600+ char description PASSES (no max cap)", () => {
    const long = "x".repeat(700);
    expect(AgentFrontmatter.safeParse({ ...VALID, description: long }).success).toBe(true);
  });

  // Reference-content regression guard: the real my-agent-kits agents validate
  // verbatim. The exhaustive fs-driven guard over ALL clone agents lives in the
  // schema-tools validate.test.ts; these inline fixtures keep the unit test
  // clone-independent while still proving real content.
  test("reference: loop-build-agent (long description + added_in)", () => {
    const fm = {
      name: "loop-build-agent",
      description:
        "Build agent for the /loop-build flow. Implements an agreed plan, gates itself on a build-acceptance pass BEFORE any code review, runs the review committee (and, on a UI build, the design/product critics), judges and incorporates feedback, and returns a structured summary. Spawned by the /loop-build skill with the plan + acceptance doc + review fixed-point + round cap in its prompt. Not for direct human invocation — it is an orchestrating subagent.",
      added_in: "0.32.0",
    };
    expect(AgentFrontmatter.safeParse(fm).success).toBe(true);
  });

  test("reference: my-mermaid-agent (641-char description)", () => {
    const fm = {
      name: "my-mermaid-agent",
      description:
        "Diagram agent for the my-mermaid skill. Authors or fixes a single Mermaid diagram in its own context: establishes ground truth, drafts render-safe Mermaid, renders headlessly to a PNG with mermaid-cli (VSCode-matching default config), reads the image back to detect and fix clipped/overlapping labels in the diagram itself, then gates on a fresh-eyes two-axis acceptance (truth vs the source, human readability) before returning. Spawned by the my-mermaid skill with the chosen diagram type, target, ground-truth source, and deliverable path in its prompt. Not for direct human invocation — it is an orchestrating subagent.",
      added_in: "0.32.0",
    };
    expect(AgentFrontmatter.safeParse(fm).success).toBe(true);
  });
});

describe("AgentFrontmatter — one invalid case per rule", () => {
  function rejects(obj: unknown): boolean {
    return !AgentFrontmatter.safeParse(obj).success;
  }

  test("missing description", () => {
    expect(rejects({ name: VALID.name })).toBe(true);
  });

  test("empty description", () => {
    expect(rejects({ ...VALID, description: "" })).toBe(true);
  });

  test("uppercase name", () => {
    expect(rejects({ ...VALID, name: "LoopBuildAgent" })).toBe(true);
  });

  test("reserved-word name (claude, case-insensitive)", () => {
    expect(rejects({ ...VALID, name: "claude-agent" })).toBe(true);
  });

  test("reserved-word name (anthropic)", () => {
    expect(rejects({ ...VALID, name: "anthropic-agent" })).toBe(true);
  });

  test("XML-char name", () => {
    expect(rejects({ ...VALID, name: "a<b" })).toBe(true);
  });

  test("name too long (>64)", () => {
    expect(rejects({ ...VALID, name: "a".repeat(65) })).toBe(true);
  });

  test("leading/trailing/consecutive hyphen names", () => {
    expect(rejects({ ...VALID, name: "-x" })).toBe(true);
    expect(rejects({ ...VALID, name: "x-" })).toBe(true);
    expect(rejects({ ...VALID, name: "x--y" })).toBe(true);
  });
});
