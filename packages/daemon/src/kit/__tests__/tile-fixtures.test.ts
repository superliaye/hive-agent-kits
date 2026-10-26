import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { FIXTURE_MAX_BYTES, RecipeFixture, replayOutcome } from "../recipes/fixture.ts";
import { TILES } from "../recipes/tiles.ts";

// Each fixture is recorded from the Tile's real repository by
// `bun run recipe-lever <tile> --record`.
const FIXTURES = join(import.meta.dir, "../recipes/fixtures");

const fixtureOf = (id: string) =>
  RecipeFixture.parse(JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), "utf8")));

describe("Tile fixtures", () => {
  test("every Tile has a fixture, and every fixture is a Tile's", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(TILES.map((tile) => `${tile.id}.json`).sort());
  });

  for (const tile of TILES) {
    describe(tile.id, () => {
      test(`is at most ${FIXTURE_MAX_BYTES} bytes`, () => {
        expect(statSync(join(FIXTURES, `${tile.id}.json`)).size).toBeLessThanOrEqual(
          FIXTURE_MAX_BYTES,
        );
      });

      test("records recognition with the Tile's own Recipe and unit", () => {
        const fixture = fixtureOf(tile.id);
        expect(fixture.tile).toBe(tile.id);
        expect(fixture.expect.tile).toMatchObject({
          recipe: tile.recipe.id,
          unit: tile.recipe.unit,
        });
      });

      test("replays to exactly the recorded Tile outcome", async () => {
        const fixture = fixtureOf(tile.id);
        expect(await Effect.runPromise(replayOutcome(fixture, tile))).toEqual(fixture.expect.tile);
      });

      test("replays to exactly the recorded generic outcome", async () => {
        const fixture = fixtureOf(tile.id);
        expect(await Effect.runPromise(replayOutcome(fixture, null))).toEqual(
          fixture.expect.generic,
        );
      });
    });
  }
});
