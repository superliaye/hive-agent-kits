import { describe, expect, test } from "bun:test";
import { PluginFrontmatter } from "@hive/capability-schema";
import { Cause, Effect, Exit } from "effect";
import { parse as yamlParse } from "yaml";
import type { TreeOrigin, TreePath } from "../acquisition/snapshot.ts";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import { SyncError } from "../effect/errors.ts";
import { type Recognition, recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { MEMORY_GIT_ORIGIN, type MemoryFile, memorySnapshot } from "./helpers.ts";

const WORKING_TREE_ORIGIN = {
  transport: "working-tree",
  repoRoot: "/repo",
  subpath: ".",
  head: "e".repeat(40),
  dirty: false,
} as const;

const claudeMarket = (plugins: unknown[]) => ({ name: "stack", owner: { name: "acme" }, plugins });
const codexMarket = (plugins: unknown[]) => ({ name: "stack", plugins });

async function recognize(
  files: Record<string, MemoryFile>,
  origin: TreeOrigin = MEMORY_GIT_ORIGIN,
): Promise<Exit.Exit<Recognition, SyncError>> {
  return Effect.runPromiseExit(
    recognizeSource(recipeTree(memorySnapshot(files, origin).snapshot, DEFAULT_TREE_LIMITS)),
  );
}

async function recognized(files: Record<string, MemoryFile>): Promise<Recognition> {
  const exit = await recognize(files);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

function pointer(recognition: Recognition, name: string): Record<string, unknown> {
  const write = recognition.projection.writes.find(
    (candidate) => candidate.to === `capabilities/plugins/${name}.plugin.md`,
  );
  if (!write) throw new Error(`no pointer for ${name}`);
  expect(write.text.startsWith("---\n")).toBe(true);
  expect(write.text.endsWith("---\n")).toBe(true);
  const parsed: unknown = yamlParse(write.text.slice(4, -4));
  return PluginFrontmatter.parse(parsed);
}

describe("Recipe recognition", () => {
  test("a tree with capabilities/ is a capability kit that copies capabilities/ and presets/", async () => {
    const recognition = await recognized({
      "capabilities/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\n",
      "presets/day.yaml": "name: day\n",
      ".claude-plugin/marketplace.json": JSON.stringify(claudeMarket([{ name: "ye" }])),
      "README.md": "kit",
    });

    expect(recognition.recipe).toEqual({
      id: "capability-kit",
      label: "Capability kit",
      unit: "pick",
    });
    expect(recognition.projection.copies.map((copy) => `${copy.from} -> ${copy.to}`)).toEqual([
      "capabilities -> capabilities",
      "presets -> presets",
    ]);
    expect(recognition.projection.writes).toEqual([]);
  });

  test("both marketplace files make a plugin marketplace whose targets follow the files", async () => {
    const recognition = await recognized({
      ".claude-plugin/marketplace.json": JSON.stringify(
        claudeMarket([
          { name: "ye", source: "./plugins/ye", description: "Personal skills." },
          { name: "claude-side", source: "./a" },
        ]),
      ),
      ".agents/plugins/marketplace.json": JSON.stringify(
        codexMarket([
          { name: "ye", source: { source: "local", path: "./plugins/ye" } },
          { name: "codex-side", source: { source: "local", path: "./b" } },
        ]),
      ),
      "b/.codex-plugin/plugin.json": JSON.stringify({ description: "From the manifest." }),
    });

    expect(recognition.recipe.id).toBe("plugin-marketplace");
    expect(recognition.projection.copies).toEqual([]);
    expect(pointer(recognition, "ye")).toEqual({
      description: "Personal skills.",
      marketplace_source: MEMORY_GIT_ORIGIN.repoUrl,
      marketplace_name: "stack",
      plugin_name: "ye",
      targets: ["claude", "codex"],
      source_commit: MEMORY_GIT_ORIGIN.resolvedCommit,
    });
    expect(pointer(recognition, "claude-side")).toMatchObject({
      targets: ["claude"],
      description: "claude-side",
    });
    expect(pointer(recognition, "codex-side")).toMatchObject({
      targets: ["codex"],
      description: "From the manifest.",
    });
  });

  test("a Codex entry whose source is a URL is accepted", async () => {
    const recognition = await recognized({
      ".claude-plugin/marketplace.json": JSON.stringify(
        claudeMarket([{ name: "superpowers", source: "./" }]),
      ),
      ".agents/plugins/marketplace.json": JSON.stringify(
        codexMarket([{ name: "superpowers", source: { source: "url", url: "./" } }]),
      ),
    });

    expect(recognition.recipe.id).toBe("plugin-marketplace");
    expect(pointer(recognition, "superpowers")).toMatchObject({ targets: ["claude", "codex"] });
  });

  test("only one marketplace file is a single-CLI marketplace for that CLI", async () => {
    const claudeOnly = await recognized({
      ".claude-plugin/marketplace.json": JSON.stringify(
        claudeMarket([
          { name: "Bad_Name", source: "./bad" },
          { name: "slidev", source: "./" },
        ]),
      ),
    });
    const codexOnly = await recognized({
      ".agents/plugins/marketplace.json": JSON.stringify(
        codexMarket([{ name: "ye", source: { source: "local", path: "./plugins/ye" } }]),
      ),
    });

    expect(claudeOnly.recipe.id).toBe("single-cli-marketplace");
    expect(claudeOnly.projection.writes.map((write) => `${write.to}`)).toEqual([
      "capabilities/plugins/slidev.plugin.md",
    ]);
    expect(pointer(claudeOnly, "slidev")).toMatchObject({ targets: ["claude"] });
    expect(codexOnly.recipe.id).toBe("single-cli-marketplace");
    expect(pointer(codexOnly, "ye")).toMatchObject({ targets: ["codex"] });
  });

  test("a tree no Recipe recognizes fails not_recognized naming what was tried", async () => {
    const exits = await Promise.all([
      recognize({ "README.md": "plain repository" }),
      recognize(
        { ".claude-plugin/marketplace.json": JSON.stringify(claudeMarket([{ name: "ye" }])) },
        WORKING_TREE_ORIGIN,
      ),
      recognize({
        ".claude-plugin/marketplace.json": JSON.stringify(claudeMarket([{ name: "ye" }])),
        ".agents/plugins/marketplace.json": JSON.stringify({
          name: "other",
          plugins: [{ name: "ye" }],
        }),
      }),
    ]);
    const details = exits.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("expected not_recognized");
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).reason).toBe("not_recognized");
      return (error as SyncError).detail ?? "";
    });

    expect(details).toEqual([
      "No Recipe matched: no capabilities/ folder; no marketplace for both CLIs; no published skills; no plugin marketplace",
      "No Recipe matched: no capabilities/ folder; not a whole git repository; no published skills",
      "No Recipe matched: no capabilities/ folder; marketplace names differ; no published skills",
    ]);
    for (const detail of details) expect(detail.length).toBeLessThanOrEqual(160);
  });
});

describe("RecipeTree", () => {
  const tree = recipeTree(
    memorySnapshot({
      "skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\nbody CLAUDE_PLUGIN_ROOT\n",
      "skills/a/SKILL.md": "no frontmatter",
      "skills/a/broken.md": "---\nname: [unclosed\n---\n",
      "skills/linked": { link: "a" },
      "skills/a/LINKED.md": { link: "../b/SKILL.md" },
      "skills/out": { link: "../../outside" },
      "data.json": "{not json",
    }).snapshot,
    DEFAULT_TREE_LIMITS,
  );
  const path = (raw: string) => raw as TreePath;

  test("answers kinds and real child directories without reading bytes", () => {
    expect(tree.childDirs(path("skills"))).toEqual(["a", "b"]);
    expect(tree.kind(path("skills/linked"))).toBe("dir");
    expect(tree.kind(path("skills/a/LINKED.md"))).toBe("file");
    expect(tree.kind(path("skills/out"))).toBe("absent");
    expect(tree.kind(path("missing"))).toBe("absent");
  });

  test("parses frontmatter, JSON, and byte mentions the way the skills CLI does", async () => {
    const run = <A>(effect: Effect.Effect<A, SyncError>) => Effect.runPromise(effect);
    expect(await run(tree.frontmatter(path("skills/a/LINKED.md")))).toEqual({
      name: "b",
      description: "B",
    });
    expect(await run(tree.frontmatter(path("skills/a/SKILL.md")))).toEqual({});
    expect(await run(tree.frontmatter(path("skills/a/broken.md")))).toBeNull();
    expect(await run(tree.frontmatter(path("skills/missing.md")))).toBeNull();
    expect(await run(tree.json(path("data.json")))).toBeUndefined();
    expect(await run(tree.mentions(path("skills/b"), "CLAUDE_PLUGIN_ROOT"))).toBe(true);
    expect(await run(tree.mentions(path("skills/a"), "CLAUDE_PLUGIN_ROOT"))).toBe(true);
    expect(await run(tree.mentions(path("data.json"), "CLAUDE_PLUGIN_ROOT"))).toBe(false);
  });
});
