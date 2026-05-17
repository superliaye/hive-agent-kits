/**
 * Validates every manifest under bundled/ against the per-kind Zod schemas
 * from ADR-0007. The real failures this catches:
 *
 *   1. YAML that doesn't parse (corrupt frontmatter)
 *   2. Missing required fields (name, description)
 *   3. Unknown fields (.strict() — catches typos like `descrption:`)
 *   4. Folder name != manifest's `name` field (silent mis-registration)
 *   5. Same-name collisions within a kind at the same layer
 *      (ADR-0007's load-time error condition)
 *   6. Harness bindings that reference Capabilities not in the bundled set
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { HarnessManifest, SkillManifest, SnippetManifest } from "../schemas.ts";
import { bundledRoot } from "../../lib/paths.ts";

const BUNDLED_ROOT = bundledRoot();

function readFrontmatter(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || match[1] === undefined) {
    throw new Error(`no YAML frontmatter in ${filePath}`);
  }
  const parsed = parse(match[1]);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`frontmatter is not a YAML object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function listSubdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => statSync(join(root, entry)).isDirectory());
}

describe("bundled/personal/skills/*/SKILL.md", () => {
  const root = join(BUNDLED_ROOT, "personal", "skills");
  const names = listSubdirs(root);

  test("at least one skill is bundled", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    test(`${name} has valid SKILL.md`, () => {
      const skillPath = join(root, name, "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);

      const fm = readFrontmatter(skillPath);
      const result = SkillManifest.safeParse(fm);
      if (!result.success) {
        throw new Error(
          `${name}/SKILL.md schema error:\n${result.error.issues
            .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n")}`,
        );
      }
      expect(result.data.name).toBe(name);
    });
  }

  test("no duplicate names in this layer", () => {
    const seen = new Set<string>();
    for (const name of names) {
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
  });
});

describe("bundled/personal/snippets/*/SNIPPET.md", () => {
  const root = join(BUNDLED_ROOT, "personal", "snippets");
  const names = listSubdirs(root);

  for (const name of names) {
    test(`${name} has valid SNIPPET.md`, () => {
      const path = join(root, name, "SNIPPET.md");
      expect(existsSync(path)).toBe(true);

      const fm = readFrontmatter(path);
      const result = SnippetManifest.safeParse(fm);
      if (!result.success) {
        throw new Error(
          `${name}/SNIPPET.md schema error:\n${result.error.issues
            .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n")}`,
        );
      }
      expect(result.data.name).toBe(name);
    });
  }
});

describe("bundled/agents/*/HARNESS.md", () => {
  const root = join(BUNDLED_ROOT, "agents");
  const names = listSubdirs(root);

  test("bundled agents present (root, agent-manager)", () => {
    expect(names).toContain("root");
    expect(names).toContain("agent-manager");
  });

  for (const name of names) {
    test(`${name} has valid HARNESS.md`, () => {
      const path = join(root, name, "HARNESS.md");
      expect(existsSync(path)).toBe(true);

      const fm = readFrontmatter(path);
      const result = HarnessManifest.safeParse(fm);
      if (!result.success) {
        throw new Error(
          `${name}/HARNESS.md schema error:\n${result.error.issues
            .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n")}`,
        );
      }
      expect(result.data.agentId).toBe(name);
    });
  }
});

describe("cross-bundled invariants", () => {
  test("every Harness binding resolves to a bundled Capability of the right kind", () => {
    const skillRoot = join(BUNDLED_ROOT, "personal", "skills");
    const snippetRoot = join(BUNDLED_ROOT, "personal", "snippets");
    const agentRoot = join(BUNDLED_ROOT, "agents");

    const skills = new Set(listSubdirs(skillRoot));
    const snippets = new Set(listSubdirs(snippetRoot));

    for (const agent of listSubdirs(agentRoot)) {
      const fm = readFrontmatter(join(agentRoot, agent, "HARNESS.md"));
      const parsed = HarnessManifest.parse(fm);

      for (const skillName of parsed.bindings.skills) {
        expect(skills.has(skillName)).toBe(true);
      }
      for (const snippetName of parsed.bindings.snippets) {
        expect(snippets.has(snippetName)).toBe(true);
      }
      // tools and mcp aren't validated against bundled/ because built-in Tools
      // live in src/capabilities/tools/ (TS handlers, not folders) and MCP
      // servers may be empty in v1.
    }
  });
});
