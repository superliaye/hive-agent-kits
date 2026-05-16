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
 *
 * Schemas are defined inline here until the Capability module lands —
 * at which point the test imports from src/capabilities/schemas/ instead.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { z } from "zod";

const BUNDLED_ROOT = resolve(import.meta.dir, "..", "..", "..", "bundled");

const NAME = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "must be lowercase kebab-case");

const SOURCE = z
  .object({
    url: z.string().min(1),
    ref: z.string().min(1),
    fetchedAt: z.string().min(1),
  })
  .strict();

const COMPATIBILITY = z
  .object({
    model: z.array(z.string()).optional(),
    system: z
      .object({
        binaries: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        services: z.array(z.string()).optional(),
        platforms: z.array(z.enum(["win32", "darwin", "linux"])).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SkillSchema = z
  .object({
    name: NAME,
    description: z.string().min(1).max(2048),
    tags: z.array(z.string()).optional(),
    source: SOURCE.optional(),
    manualInvocationOnly: z.boolean().optional(),
    allowedTools: z.array(z.string()).optional(),
    argumentHint: z.string().optional(),
    compatibility: COMPATIBILITY.optional(),
  })
  .strict();

const SnippetSchema = z
  .object({
    name: NAME,
    description: z.string().min(1).max(2048),
    tags: z.array(z.string()).optional(),
    source: SOURCE.optional(),
  })
  .strict();

const HarnessSchema = z
  .object({
    agentId: NAME,
    backend: z.enum(["native", "claude-code", "codex"]),
    domain: z.string().min(1),
    bindings: z
      .object({
        skills: z.array(z.string()).default([]),
        snippets: z.array(z.string()).default([]),
        tools: z.array(z.string()).default([]),
        mcp: z.array(z.string()).default([]),
      })
      .strict(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

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
      const result = SkillSchema.safeParse(fm);
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
      const result = SnippetSchema.safeParse(fm);
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
      const result = HarnessSchema.safeParse(fm);
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
      const parsed = HarnessSchema.parse(fm);

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
