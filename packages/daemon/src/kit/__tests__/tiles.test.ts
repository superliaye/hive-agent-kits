import { describe, expect, test } from "bun:test";
import { SourceLocator } from "@hive/contract";
import { locatorIdentity } from "../../sources/types.ts";
import { publishedSkills } from "../recipes/published-skills.ts";
import { capabilityKit, pluginMarketplace } from "../recipes/recipe.ts";
import { TILES, tileById, tileForLocator } from "../recipes/tiles.ts";

describe("TILES", () => {
  test("ids and locator identities are unique", () => {
    expect(new Set(TILES.map((tile) => tile.id)).size).toBe(TILES.length);
    expect(new Set(TILES.map((tile) => locatorIdentity(tile.locator))).size).toBe(TILES.length);
  });

  test("every locator is a valid Source Locator, and every git Tile tracks main", () => {
    for (const tile of TILES) {
      expect(SourceLocator.safeParse(tile.locator).success).toBe(true);
      if (tile.locator.kind === "git") expect(tile.locator.revision.ref).toBe("refs/heads/main");
    }
  });

  test("the Starter is the first Tile", () => {
    expect(TILES[0]?.locator).toEqual({ kind: "starter" });
  });

  test("only HyperFrames narrows a generic Recipe to whole, and the Recipe it reuses stays pick", () => {
    expect(
      TILES.filter((tile) => tile.recipe.trust === "generic" && tile.recipe.unit === "whole").map(
        (tile) => tile.id,
      ),
    ).toEqual(["hyperframes"]);
    expect(tileById("hyperframes")?.recipe.id).toBe(publishedSkills.id);
    expect(publishedSkills.unit).toBe("pick");
  });

  test("a Tile's unit is whole only where its Recipe is a repo Recipe or the Tile narrows a pick Recipe", () => {
    const reusable = new Map(
      [capabilityKit, pluginMarketplace, publishedSkills].map((recipe) => [recipe.id, recipe]),
    );
    for (const tile of TILES) {
      if (tile.recipe.trust === "repo") {
        expect([tile.id, tile.recipe.unit]).toEqual([tile.id, "whole"]);
      } else {
        expect([tile.id, reusable.get(tile.recipe.id)?.unit]).toEqual([tile.id, "pick"]);
      }
    }
  });

  test("gstack and UI UX Pro Max carry the repo-specific Recipes", () => {
    expect(TILES.filter((tile) => tile.recipe.trust === "repo").map((tile) => tile.id)).toEqual([
      "gstack",
      "ui-ux-pro-max",
    ]);
  });

  test("every installer path is relative and stays inside its home", () => {
    for (const tile of TILES) {
      if (tile.recipe.trust !== "repo") continue;
      const { checkout, targets } = tile.recipe.installer;
      const paths = [
        ...Object.values(checkout?.at ?? {}),
        ...Object.values(targets).flatMap((installer) => installer.proofs),
      ];
      expect(paths.length).toBeGreaterThan(0);
      for (const { path } of paths) {
        expect(
          path.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
        ).toBe(true);
      }
    }
  });
});

describe("Tile lookup", () => {
  test("a pasted locator equal to a Tile's after normalization finds that Tile", () => {
    const tile = tileForLocator({
      kind: "git",
      repoUrl: "https://GitHub.com/heygen-com/hyperframes.git/",
      revision: { mode: "track", ref: "refs/heads/main" },
      subpath: ".",
    });
    expect(tile?.id).toBe("hyperframes");
    expect(
      tileForLocator({
        kind: "git",
        repoUrl: "https://github.com/heygen-com/hyperframes",
        revision: { mode: "track", ref: "refs/heads/dev" },
        subpath: ".",
      }),
    ).toBeNull();
  });

  test("the Starter locator is the Starter Tile's, and another subpath is no Tile's", () => {
    expect(tileForLocator({ kind: "starter" })?.id).toBe("starter");
    const hyperframes = tileById("hyperframes");
    if (hyperframes?.locator.kind !== "git") throw new Error("hyperframes is a git Tile");
    expect(tileForLocator({ ...hyperframes.locator, subpath: "skills" })).toBeNull();
  });
});
