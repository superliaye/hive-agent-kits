/**
 * Unit tests for the vendor script's pure functions.
 *
 * Focused on real failure modes:
 *   - splitAllowedToolsString must respect parens (dormant bug today; would
 *     break the first time an upstream uses string-form allowed-tools with
 *     commas inside Bash globs)
 *   - splitFrontmatter must reject missing/malformed frontmatter
 *   - transformFrontmatter must produce schema-valid output and report drops
 *   - looksLikeProjectRoot must refuse symlinks and project repos (the
 *     1.4 GB gstack-as-full-repo trap from the migration)
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  classify,
  looksLikeProjectRoot,
  splitAllowedToolsString,
  splitFrontmatter,
  transformFrontmatter,
} from "../vendor-from-local.ts";

describe("splitAllowedToolsString", () => {
  test("simple comma list", () => {
    expect(splitAllowedToolsString("Read, Edit, Grep")).toEqual(["Read", "Edit", "Grep"]);
  });

  test("respects parens with commas inside", () => {
    // The exact case that would have shipped broken without this fix:
    // `Bash(npm:*, rushx:*)` is ONE tool spec, not three.
    expect(splitAllowedToolsString("Bash(npm:*, rushx:*), Read")).toEqual([
      "Bash(npm:*, rushx:*)",
      "Read",
    ]);
  });

  test("nested parens", () => {
    expect(splitAllowedToolsString("Tool(a, b(c, d)), Other")).toEqual([
      "Tool(a, b(c, d))",
      "Other",
    ]);
  });

  test("trims whitespace", () => {
    expect(splitAllowedToolsString("  Read  ,   Edit  ")).toEqual(["Read", "Edit"]);
  });

  test("empty string returns empty array", () => {
    expect(splitAllowedToolsString("")).toEqual([]);
  });
});

describe("splitFrontmatter", () => {
  test("extracts frontmatter and body", () => {
    const content = "---\nname: foo\n---\n\nBody here.";
    const { frontmatter, body } = splitFrontmatter(content);
    expect(frontmatter).toBe("name: foo");
    expect(body.trim()).toBe("Body here.");
  });

  test("handles CRLF line endings", () => {
    const content = "---\r\nname: foo\r\n---\r\n\r\nBody.";
    const { frontmatter } = splitFrontmatter(content);
    expect(frontmatter).toBe("name: foo");
  });

  test("throws on missing frontmatter", () => {
    expect(() => splitFrontmatter("No frontmatter at all")).toThrow();
  });

  test("throws on malformed frontmatter (no closing fence)", () => {
    expect(() => splitFrontmatter("---\nname: foo\nstuff")).toThrow();
  });
});

describe("transformFrontmatter", () => {
  const source = { url: "github.com/x/y", ref: "1.0.0", fetchedAt: "2026-05-16" };

  test("preserves name, description, and adds source", () => {
    const dropped = {};
    const result = transformFrontmatter(
      { name: "foo", description: "  Does the thing.  " },
      source,
      dropped,
    );
    expect(result).toEqual({
      name: "foo",
      description: "Does the thing.",
      source,
    });
  });

  test("renames allowed-tools (array) to allowedTools", () => {
    const dropped = {};
    const result = transformFrontmatter(
      { name: "foo", description: "x", "allowed-tools": ["Read", "Edit"] },
      source,
      dropped,
    );
    expect(result.allowedTools).toEqual(["Read", "Edit"]);
  });

  test("splits string-form allowed-tools respecting parens", () => {
    const dropped = {};
    const result = transformFrontmatter(
      {
        name: "foo",
        description: "x",
        "allowed-tools": "Bash(npm:*, rushx:*), Read",
      },
      source,
      dropped,
    );
    expect(result.allowedTools).toEqual(["Bash(npm:*, rushx:*)", "Read"]);
  });

  test("renames disable-model-invocation to manualInvocationOnly", () => {
    const dropped = {};
    const result = transformFrontmatter(
      { name: "foo", description: "x", "disable-model-invocation": true },
      source,
      dropped,
    );
    expect(result.manualInvocationOnly).toBe(true);
  });

  test("renames argument-hint to argumentHint", () => {
    const dropped = {};
    const result = transformFrontmatter(
      { name: "foo", description: "x", "argument-hint": "[optional]" },
      source,
      dropped,
    );
    expect(result.argumentHint).toBe("[optional]");
  });

  test("tracks dropped fields in the report", () => {
    const dropped: Record<string, { count: number; reason: string }> = {};
    transformFrontmatter(
      {
        name: "foo",
        description: "x",
        "preamble-tier": 1,
        triggers: ["a", "b"],
        unknown_field: "?",
      },
      source,
      dropped,
    );
    expect(dropped["preamble-tier"]?.count).toBe(1);
    expect(dropped["triggers"]?.count).toBe(1);
    expect(dropped["unknown_field"]?.count).toBe(1);
    expect(dropped["unknown_field"]?.reason).toContain("unknown");
  });
});

describe("looksLikeProjectRoot", () => {
  const TMP = join(tmpdir(), `hive-vendor-test-${Date.now()}`);

  test("returns null for a plain skill folder", () => {
    const dir = join(TMP, "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: plain\n---\nBody.");
    expect(looksLikeProjectRoot(dir)).toBeNull();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("refuses a folder with project-root markers", () => {
    // The exact 1.4 GB trap shape: a folder containing package.json + bun.lock
    // is a project repo masquerading as a skill folder.
    const dir = join(TMP, "fake-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\nBody.");
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "bun.lock"), "");
    expect(looksLikeProjectRoot(dir)).toContain("project-root markers");
    rmSync(TMP, { recursive: true, force: true });
  });

  test("refuses a symlink (cross-platform — only runs where supported)", () => {
    const target = join(TMP, "real");
    const link = join(TMP, "link");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "---\nname: real\n---");
    try {
      symlinkSync(target, link, "dir");
    } catch (err) {
      // Windows without dev-mode/admin can't create symlinks; skip the assertion.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        rmSync(TMP, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    expect(looksLikeProjectRoot(link)).toContain("symbolic link");
    rmSync(TMP, { recursive: true, force: true });
  });
});

describe("classify", () => {
  test("hyperframes-set skills classify to hyperframes pin", () => {
    expect(classify("hyperframes")).toMatchObject({
      url: "github.com/heygen-com/hyperframes",
    });
    expect(classify("gsap")?.ref).toBe("0.6.14");
  });

  test("non-vendored skills classify to null", () => {
    expect(classify("my-commit")).toBeNull();
    expect(classify("random-skill")).toBeNull();
  });

  test("gstack skills no longer classify (removed in CQ3)", () => {
    expect(classify("gstack-codex")).toBeNull();
    expect(classify("gstack")).toBeNull();
  });
});
