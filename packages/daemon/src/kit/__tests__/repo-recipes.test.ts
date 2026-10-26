import { describe, expect, test } from "bun:test";
import { BundleFrontmatter } from "@hive/capability-schema";
import { Cause, Effect, Exit } from "effect";
import { parse as yamlParse } from "yaml";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import type { SyncError } from "../effect/errors.ts";
import { type Recognition, recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { type Tile, tileById } from "../recipes/tiles.ts";
import { MEMORY_GIT_ORIGIN, type MemoryFile, memorySnapshot } from "./helpers.ts";

function tile(id: string): Tile {
  const found = tileById(id);
  if (!found) throw new Error(`no Tile ${id}`);
  return found;
}

function recognize(
  files: Record<string, MemoryFile>,
  as: Tile | null,
): Promise<Exit.Exit<Recognition, SyncError>> {
  const tree = recipeTree(memorySnapshot(files).snapshot, DEFAULT_TREE_LIMITS);
  return Effect.runPromiseExit(recognizeSource(tree, as));
}

async function recognized(files: Record<string, MemoryFile>, as: Tile | null) {
  const exit = await recognize(files, as);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

async function missDetail(files: Record<string, MemoryFile>, as: Tile): Promise<string> {
  const exit = await recognize(files, as);
  if (Exit.isSuccess(exit)) throw new Error("recognized");
  const error = Cause.squash(exit.cause) as SyncError;
  expect(error.reason).toBe("not_recognized");
  return error.detail ?? "";
}

function written(recognition: Recognition, to: string): string {
  const write = recognition.projection.writes.find((candidate) => candidate.to === to);
  if (!write) throw new Error(`no write to ${to}`);
  return write.text;
}

const frontmatter = (text: string): unknown => yamlParse(text.slice(4, -4));

const GSTACK_TREE: Record<string, MemoryFile> = {
  "SKILL.md": "---\nname: gstack\ndescription: Router for the gstack skill suite.\n---\n",
  setup: { exec: "#!/usr/bin/env bash\n" },
  "bin/gstack-uninstall": { exec: "#!/usr/bin/env bash\n" },
  "ship/SKILL.md": "---\nname: ship\ndescription: ship\n---\n",
};

const UI_UX_PRO_MAX_TREE: Record<string, MemoryFile> = {
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "ui-ux-pro-max-skill",
    plugins: [{ name: "ui-ux-pro-max", source: "./", description: "UI/UX design intelligence." }],
  }),
};

describe("gstack Recipe", () => {
  test("projects one bundle named after the Tile and the repository tree as the checkout", async () => {
    const recognition = await recognized(GSTACK_TREE, tile("gstack"));
    expect(recognition.recipe).toEqual({
      id: "gstack-setup",
      label: "gstack setup",
      unit: "whole",
    });
    expect(
      recognition.projection.copies.map((copy) => `${copy.from} -> ${copy.to} (${copy.exclude})`),
    ).toEqual([" -> checkout (none)"]);
    expect(recognition.projection.writes.map((write) => `${write.to}`)).toEqual([
      "capabilities/bundles/gstack.bundle.md",
    ]);
    expect(
      BundleFrontmatter.parse(
        frontmatter(written(recognition, "capabilities/bundles/gstack.bundle.md")),
      ),
    ).toMatchObject({
      installer: { kind: "tile", tile: "gstack" },
      targets: ["claude", "codex"],
      source_commit: MEMORY_GIT_ORIGIN.resolvedCommit,
    });
  });

  test("misses without its uninstaller, though the generic list would take the router skill", async () => {
    const { "bin/gstack-uninstall": _uninstaller, ...tree } = GSTACK_TREE;
    expect(await missDetail(tree, tile("gstack"))).toContain("no bin/gstack-uninstall");
    expect((await recognized(tree, null)).recipe.id).toBe("published-skills");
  });

  test("misses without its setup script", async () => {
    const { setup: _setup, ...tree } = GSTACK_TREE;
    expect(await missDetail(tree, tile("gstack"))).toContain("no setup script");
  });
});

describe("UI UX Pro Max Recipe", () => {
  test("projects the Claude plugin pointer the marketplace Recipe makes, and a Codex-only bundle", async () => {
    const recognition = await recognized(UI_UX_PRO_MAX_TREE, tile("ui-ux-pro-max"));
    const generic = await recognized(UI_UX_PRO_MAX_TREE, null);
    expect(generic.recipe.id).toBe("single-cli-marketplace");
    const plugin = "capabilities/plugins/ui-ux-pro-max.plugin.md";
    expect(written(recognition, plugin)).toBe(written(generic, plugin));
    expect(recognition.projection.copies).toEqual([]);
    expect(
      BundleFrontmatter.parse(
        frontmatter(written(recognition, "capabilities/bundles/ui-ux-pro-max.bundle.md")),
      ),
    ).toMatchObject({ installer: { kind: "tile", tile: "ui-ux-pro-max" }, targets: ["codex"] });
  });

  test("misses when its marketplace does not list the plugin", async () => {
    const tree = {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "ui-ux-pro-max-skill",
        plugins: [{ name: "other" }],
      }),
    };
    expect(await missDetail(tree, tile("ui-ux-pro-max"))).toContain(
      "the Claude marketplace does not list ui-ux-pro-max",
    );
  });
});
