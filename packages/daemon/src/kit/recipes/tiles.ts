// Tiles: the curated Sources Hive ships on its shelf (ADR-0033). Each names a
// Source Locator and the Recipe Onboarding verified for that repository.

import type { SelectionUnit, Source, SourceLocator, TileSummary } from "@hive/contract";
import { locatorIdentity } from "../../sources/types.ts";
import { publishedSkills } from "./published-skills.ts";
import { capabilityKit, pluginMarketplace, type Recipe } from "./recipe.ts";
import { gstackRecipe, uiUxProMaxRecipe } from "./repo-recipes.ts";

type GitLocator = Extract<SourceLocator, { kind: "git" }>;
// A Tile names its ref, because SourceLocator has no default-branch mode.
export type TileLocator =
  | Extract<SourceLocator, { kind: "starter" }>
  | (GitLocator & { readonly revision: Extract<GitLocator["revision"], { mode: "track" }> });

declare const tileBrand: unique symbol;
export type Tile = {
  readonly [tileBrand]: true;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly locator: TileLocator;
  // Its unit is the Tile's Selection unit, after any narrowing.
  readonly recipe: Recipe;
};

// The only Tile constructor. A Tile may narrow a pick Recipe to whole, never
// widen one: `unit` must be "whole" unless the Recipe is a pick Recipe.
function defineTile<R extends Recipe>(spec: {
  id: string;
  label: string;
  description: string;
  locator: TileLocator;
  recipe: R;
  unit: R["unit"] extends "pick" ? SelectionUnit : "whole";
}): Tile {
  const recipe: Recipe = spec.recipe;
  const unit: SelectionUnit = spec.unit;
  const { id, label, description, locator } = spec;
  return {
    id,
    label,
    description,
    locator,
    recipe: recipe.trust === "generic" && recipe.unit !== unit ? { ...recipe, unit } : recipe,
  } as Tile;
}

const MAIN = "refs/heads/main";

function tracking(repoUrl: string, ref: string, subpath = "."): TileLocator {
  return { kind: "git", repoUrl, revision: { mode: "track", ref }, subpath };
}

// The shelf, in display order. GET /api/tiles, adding by Tile or by a Tile's
// pasted link, recognition, and the source.added audit event all read this one
// list.
export const TILES: readonly Tile[] = [
  defineTile({
    id: "starter",
    label: "Starter",
    description: "The capability kit bundled with Hive.",
    locator: { kind: "starter" },
    recipe: capabilityKit,
    unit: "pick",
  }),
  defineTile({
    id: "my-agent-kits",
    label: "my-agent-kits",
    description: "A personal capability kit of working and experimental Capabilities.",
    locator: tracking("https://github.com/superliaye/my-agent-kits", MAIN),
    recipe: capabilityKit,
    unit: "pick",
  }),
  defineTile({
    id: "yestack",
    label: "yestack",
    description: "The ye plugin, from its own marketplace for Claude Code and Codex.",
    locator: tracking("https://github.com/superliaye/yestack", MAIN),
    recipe: pluginMarketplace,
    unit: "pick",
  }),
  defineTile({
    id: "superpowers",
    label: "Superpowers",
    description:
      "The superpowers plugin, with its skills and session-start hook, from its own marketplace for Claude Code and Codex.",
    locator: tracking("https://github.com/obra/superpowers", MAIN),
    recipe: pluginMarketplace,
    unit: "pick",
  }),
  defineTile({
    id: "archify",
    label: "Archify",
    description: "The archify skill, deployed as its repository publishes it.",
    locator: tracking("https://github.com/tt-a1i/archify", MAIN),
    recipe: publishedSkills,
    unit: "pick",
  }),
  defineTile({
    id: "slidev",
    label: "Slidev",
    description: "The Slidev skill, for writing presentations with Slidev.",
    locator: tracking("https://github.com/slidevjs/slidev", MAIN),
    recipe: publishedSkills,
    unit: "pick",
  }),
  defineTile({
    id: "hyperframes",
    label: "HyperFrames",
    description:
      "HeyGen's seven HyperFrames skills, installed together because they work as one product.",
    locator: tracking("https://github.com/heygen-com/hyperframes", MAIN),
    recipe: publishedSkills,
    unit: "whole",
  }),
  defineTile({
    id: "frontend-design",
    label: "Frontend design",
    description: "Anthropic's frontend-design skill, the same skill as its official Claude plugin.",
    locator: tracking("https://github.com/anthropics/skills", MAIN, "skills/frontend-design"),
    recipe: publishedSkills,
    unit: "pick",
  }),
  defineTile({
    id: "gstack",
    label: "gstack",
    description:
      "Garry Tan's gstack skills (plan reviews, QA, ship, browse), installed and removed by the repository's own setup and uninstall scripts.",
    locator: tracking("https://github.com/garrytan/gstack", MAIN),
    recipe: gstackRecipe,
    unit: "whole",
  }),
  defineTile({
    id: "ui-ux-pro-max",
    label: "UI UX Pro Max",
    description:
      "UI/UX design guidance: the ui-ux-pro-max plugin on Claude Code, and the skills its uipro CLI installs on Codex.",
    locator: tracking("https://github.com/nextlevelbuilder/ui-ux-pro-max-skill", MAIN),
    recipe: uiUxProMaxRecipe,
    unit: "whole",
  }),
];

export function tileById(id: string): Tile | null {
  return TILES.find((tile) => tile.id === id) ?? null;
}

// The only derivation of a Source's Tile: a Source is a Tile's Source exactly
// when its locator is the Tile's, however it was added. The Tile's Recipe was
// reviewed for exactly that repository, so a pasted link equal to a Tile's
// gains no new trust.
export function tileForLocator(locator: SourceLocator): Tile | null {
  const identity = locatorIdentity(locator);
  return TILES.find((tile) => locatorIdentity(tile.locator) === identity) ?? null;
}

export function tileShelf(sources: readonly Pick<Source, "id" | "locator">[]): TileSummary[] {
  return TILES.map((tile) => ({
    id: tile.id,
    label: tile.label,
    description: tile.description,
    recipe: { id: tile.recipe.id, label: tile.recipe.label, unit: tile.recipe.unit },
    sourceId: sources.find((source) => tileForLocator(source.locator) === tile)?.id ?? null,
  }));
}
