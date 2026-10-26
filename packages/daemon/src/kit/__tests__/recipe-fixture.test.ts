import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import type { TreePath } from "../acquisition/snapshot.ts";
import { DEFAULT_TREE_LIMITS } from "../acquisition/tree-guard.ts";
import {
  RecipeFixture,
  recordFixture,
  replayOutcome,
  replayTree,
  serializeFixture,
} from "../recipes/fixture.ts";
import { recipeTree, recognizeSource } from "../recipes/recipe.ts";
import { tileById } from "../recipes/tiles.ts";
import { type MemoryFile, memorySnapshot } from "./helpers.ts";

const skill = (name: string, body = "body\n") =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`;
const market = { name: "stack", plugins: [{ name: "stack", source: "./" }] };

// Both marketplaces list a plugin, so the generic list stops at
// plugin-marketplace while the HyperFrames Tile's published-skills Recipe, narrowed
// to whole, sees the skills.
const REPOSITORY: Record<string, MemoryFile> = {
  ".claude-plugin/marketplace.json": JSON.stringify(market),
  ".claude-plugin/plugin.json": "null",
  ".agents/plugins/marketplace.json": JSON.stringify(market),
  "skills/alpha/SKILL.md": skill("alpha"),
  "skills/alpha/scripts/run.sh": { exec: "#!/bin/sh\n" },
  "skills/alpha/metadata.json": "{}",
  "skills/beta/SKILL.md": skill("beta", `Run \${CLAUDE_PLUGIN_ROOT}/bin/beta.\n`),
  "skills/gamma/SKILL.md": skill("gamma"),
  "skills/gamma/notes": { link: "../alpha/scripts" },
  "README.md": "stack\n",
};

const hyperframes = tileById("hyperframes");
if (!hyperframes) throw new Error("the HyperFrames Tile is on the shelf");
const tile = hyperframes;

async function recorded(files: Record<string, MemoryFile>): Promise<RecipeFixture> {
  const { snapshot } = memorySnapshot(files);
  const fixture = await Effect.runPromise(recordFixture(tile, snapshot, DEFAULT_TREE_LIMITS));
  return RecipeFixture.parse(JSON.parse(serializeFixture(fixture)));
}

async function failure(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return Cause.squash(exit.cause);
}

describe("Recipe fixtures", () => {
  test("a recorded tree replays recognition identically, projection included", async () => {
    const fixture = await recorded(REPOSITORY);
    const live = recipeTree(memorySnapshot(REPOSITORY).snapshot, DEFAULT_TREE_LIMITS);

    for (const asTile of [tile, null]) {
      expect(await Effect.runPromise(recognizeSource(replayTree(fixture), asTile))).toEqual(
        await Effect.runPromise(recognizeSource(live, asTile)),
      );
    }
    expect(await Effect.runPromise(replayOutcome(fixture, tile))).toEqual(fixture.expect.tile);
    expect(await Effect.runPromise(replayOutcome(fixture, null))).toEqual(fixture.expect.generic);
    expect(fixture.expect).toEqual({
      tile: {
        recipe: "published-skills",
        unit: "whole",
        capabilities: [
          { capability: "skill/alpha", files: 2 },
          { capability: "skill/gamma", files: 2 },
        ],
      },
      generic: {
        recipe: "plugin-marketplace",
        unit: "pick",
        capabilities: [{ capability: "plugin/stack", files: 1 }],
      },
    });
    expect(fixture.answers["json .claude-plugin/plugin.json"]).toEqual([null]);
    expect(fixture.answers["json skills-lock.json"]).toEqual([]);
  });

  test("re-recording an unchanged tree writes identical bytes with sorted answer keys", async () => {
    const { snapshot } = memorySnapshot(REPOSITORY);
    const first = serializeFixture(
      await Effect.runPromise(recordFixture(tile, snapshot, DEFAULT_TREE_LIMITS)),
    );
    const again = serializeFixture(
      await Effect.runPromise(recordFixture(tile, snapshot, DEFAULT_TREE_LIMITS)),
    );
    expect(again).toBe(first);
    const keys = Object.keys(RecipeFixture.parse(JSON.parse(first)).answers);
    expect(keys).toEqual([...keys].sort());
  });

  test("an unrecorded query fails, naming the key and the re-record command", async () => {
    const fixture = await recorded(REPOSITORY);
    const rerecord =
      "re-record it with `bun run recipe-lever hyperframes --record` in packages/daemon";

    expect(() => replayTree(fixture).kind("skills/delta/SKILL.md" as TreePath)).toThrow(
      `The hyperframes fixture has no answer for "kind skills/delta/SKILL.md"; ${rerecord}`,
    );
    const { "frontmatter skills/alpha/SKILL.md": _, ...answers } = fixture.answers;
    const error = await failure(replayOutcome({ ...fixture, answers }, tile));
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      `no answer for "frontmatter skills/alpha/SKILL.md"; ${rerecord}`,
    );
  });

  test("a malformed answer fails with the re-record command", async () => {
    const fixture = await recorded(REPOSITORY);
    const answers = { ...fixture.answers, "dirs ": "skills" };
    const error = await failure(replayOutcome({ ...fixture, answers }, tile));
    expect(String(error)).toContain(`The hyperframes fixture's answer for "dirs " is malformed`);
  });
});
