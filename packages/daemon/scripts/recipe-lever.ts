#!/usr/bin/env bun
// The recognition lever (ADR-0033): opens a real snapshot of a Tile or a
// repository in a throwaway cache with Sync's code and limits, recognizes it as
// Sync would, and reports the Recipe, each projected capability, and what the
// Mirror would ingest. For a Tile it also reports recognition with the generic
// list alone, and --record writes the Tile's fixture after replaying it.
// --compare-npx also lists the repository with `npx skills@1.7.2 add --list` and
// fails when its skills differ from the skills Hive projects.
//
//   bun run recipe-lever <tile-id | https-url> [--ref <ref>] [--record] [--compare-npx]
//
// A Tile id uses the Tile's locator, ref and subpath included; the Starter Tile
// reads the bundled Starter. A URL is a whole repository at --ref (default
// main), and is a Tile's Source when it equals that Tile's locator, as at Sync.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { Cause, Effect, Exit, type Scope } from "effect";
import pino from "pino";
import { gitSnapshot } from "../src/kit/acquisition/git-source.ts";
import { directorySnapshot, type TreeSnapshot } from "../src/kit/acquisition/snapshot.ts";
import { DEFAULT_TREE_LIMITS } from "../src/kit/acquisition/tree-guard.ts";
import { bundledStarterRoot } from "../src/kit/bundled-starter.ts";
import { SyncError } from "../src/kit/effect/errors.ts";
import { materialize } from "../src/kit/mirror.ts";
import {
  FIXTURE_MAX_BYTES,
  groupByCapability,
  type Outcome,
  RecipeFixture,
  recordFixture,
  replayOutcome,
  serializeFixture,
} from "../src/kit/recipes/fixture.ts";
import { sanitizeName } from "../src/kit/recipes/published-skills.ts";
import { recipeTree, recognizeSource } from "../src/kit/recipes/recipe.ts";
import {
  TILES,
  type Tile,
  type TileLocator,
  tileById,
  tileForLocator,
} from "../src/kit/recipes/tiles.ts";
import { setLogger } from "../src/lib/log.ts";

const SKILLS_CLI = "skills@1.7.2";
const FIXTURES = join(import.meta.dir, "../src/kit/recipes/fixtures");
const USAGE = "usage: recipe-lever <tile-id | https-url> [--ref <ref>] [--record] [--compare-npx]";

type Args = { target: string; ref: string | null; record: boolean; compareNpx: boolean };

function parseArgs(argv: readonly string[]): Args | null {
  let target: string | undefined;
  let ref: string | null = null;
  let record = false;
  let compareNpx = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--compare-npx") compareNpx = true;
    else if (arg === "--record") record = true;
    else if (arg === "--ref") {
      const value = argv[++index];
      if (!value) return null;
      ref = value.startsWith("refs/") ? value : `refs/heads/${value}`;
    } else if (arg && !arg.startsWith("--") && target === undefined) target = arg;
    else return null;
  }
  return target ? { target, ref, record, compareNpx } : null;
}

type Target = { locator: TileLocator; tile: Tile | null };

function resolveTarget(args: Args): Target | string {
  if (args.target.startsWith("https://")) {
    const locator: TileLocator = {
      kind: "git",
      repoUrl: args.target,
      revision: { mode: "track", ref: args.ref ?? "refs/heads/main" },
      subpath: ".",
    };
    const tile = tileForLocator(locator);
    if (args.record && !tile) return `--record needs a Tile; ${args.target} is no Tile's locator`;
    return { locator, tile };
  }
  const tile = tileById(args.target);
  if (!tile) {
    return `${args.target} is neither an https URL nor a Tile id (${TILES.map((t) => t.id).join(", ")})`;
  }
  if (args.ref) return "--ref applies to a URL; a Tile names its own ref";
  return { locator: tile.locator, tile };
}

function openSnapshot(
  locator: TileLocator,
  work: string,
): Effect.Effect<TreeSnapshot, SyncError, Scope.Scope> {
  return locator.kind === "starter"
    ? Effect.suspend(() => directorySnapshot(bundledStarterRoot(work)))
    : gitSnapshot(locator, { cacheRoot: join(work, "git-cache"), limits: DEFAULT_TREE_LIMITS });
}

type MirrorFile = { rel: string; size: number };

function mirrorFiles(stage: string): MirrorFile[] {
  return readdirSync(stage, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { rel: relative(stage, path), size: statSync(path).size };
    });
}

type Projected =
  | {
      recipe: { id: string; label: string; unit: string };
      capabilities: { name: string; files: number; bytes: number }[];
      files: number;
      bytes: number;
    }
  | { notRecognized: string };

type Report = {
  commit: string | null;
  listed: number;
  fixture: RecipeFixture | null;
  projected: Projected;
};

// Recognizes the snapshot as Sync would, after recording the Tile's fixture
// from the same snapshot.
function inspect(target: Target, work: string): Effect.Effect<Report, SyncError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const snapshot = yield* openSnapshot(target.locator, work);
      const { origin } = snapshot;
      const head = {
        commit: origin.transport === "git" ? origin.resolvedCommit : null,
        listed: snapshot.entries.size,
        fixture: target.tile
          ? yield* recordFixture(target.tile, snapshot, DEFAULT_TREE_LIMITS)
          : null,
      };
      const recognized = yield* Effect.result(
        recognizeSource(recipeTree(snapshot, DEFAULT_TREE_LIMITS), target.tile),
      );
      if (recognized._tag === "Failure") {
        const error = recognized.failure;
        if (error.reason !== "not_recognized") return yield* Effect.fail(error);
        return { ...head, projected: { notRecognized: error.detail ?? error.message } };
      }
      const staged = yield* materialize(
        snapshot,
        recognized.success,
        join(work, "tmp"),
        DEFAULT_TREE_LIMITS,
      );
      const files = mirrorFiles(staged.stage);
      const sizes = new Map(files.map((file) => [file.rel, file.size]));
      const capabilities = [...groupByCapability(files.map((file) => file.rel))].map(
        ([name, paths]) => ({
          name,
          files: paths.length,
          bytes: paths.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0),
        }),
      );
      return {
        ...head,
        projected: {
          recipe: recognized.success.recipe,
          capabilities,
          files: files.length,
          bytes: files.reduce((sum, file) => sum + file.size, 0),
        },
      };
    }),
  );
}

// The skill names `skills add --list` prints: clack indents a name two spaces
// past the gutter and its description four.
function npxSkillNames(locator: Extract<TileLocator, { kind: "git" }>): string[] | string {
  const branch = locator.revision.ref.replace(/^refs\/(heads|tags)\//, "");
  const subpath = locator.subpath === "." ? "" : `/${locator.subpath}`;
  const target =
    branch === "main" && !subpath ? locator.repoUrl : `${locator.repoUrl}/tree/${branch}${subpath}`;
  const run = spawnSync("npx", ["-y", SKILLS_CLI, "add", target, "--list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  const output = stripVTControlCharacters(`${run.stdout ?? ""}`);
  if (run.status !== 0) return `npx exited ${run.status}: ${output.trim().split("\n").pop() ?? ""}`;
  const names: string[] = [];
  let listing = false;
  for (const line of output.split("\n")) {
    if (line.includes("Available Skills")) listing = true;
    else if (line.includes("Use --skill")) listing = false;
    else if (listing) {
      const match = /^│ {4}(\S.*)$/.exec(line);
      if (match?.[1]) names.push(match[1].trim());
    }
  }
  return names;
}

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function describe(outcome: Outcome): string {
  if ("notRecognized" in outcome) return `not recognized: ${outcome.notRecognized}`;
  const names = outcome.capabilities.map((entry) => entry.capability);
  const listed = names.length <= 8 ? names.join(", ") : `${names.length} entries`;
  return `${outcome.recipe}, unit ${outcome.unit}: ${listed}`;
}

// Writes the fixture only when replaying it reproduces the live outcomes and
// the Tile's own Recipe recognizes the repository.
async function writeFixture(tile: Tile, fixture: RecipeFixture): Promise<boolean> {
  const text = serializeFixture(fixture);
  const bytes = Buffer.byteLength(text);
  const expected = fixture.expect.tile;
  if ("notRecognized" in expected || expected.recipe !== tile.recipe.id) {
    console.log(`Not recorded: the ${tile.id} Tile's Recipe ${tile.recipe.id} does not match`);
    return false;
  }
  const parsed = RecipeFixture.parse(JSON.parse(text));
  const replayed = await Effect.runPromise(
    Effect.all({ tile: replayOutcome(parsed, tile), generic: replayOutcome(parsed, null) }),
  );
  if (!isDeepStrictEqual(replayed, parsed.expect)) {
    console.log("Not recorded: replaying the recording does not reproduce the live outcomes");
    return false;
  }
  if (bytes > FIXTURE_MAX_BYTES) {
    console.log(`Not recorded: ${bytes} bytes exceeds the ${FIXTURE_MAX_BYTES}-byte fixture bound`);
    return false;
  }
  mkdirSync(FIXTURES, { recursive: true });
  const path = join(FIXTURES, `${tile.id}.json`);
  writeFileSync(path, text);
  console.log(`Recorded    ${relative(process.cwd(), path)} (${bytes} bytes)`);
  return true;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const target = resolveTarget(args);
  if (typeof target === "string") {
    console.error(`${target}\n${USAGE}`);
    return 2;
  }
  if (args.compareNpx && target.locator.kind !== "git") {
    console.error("--compare-npx needs a git Source");
    return 2;
  }
  const notes = new Set<string>();
  setLogger(
    pino(
      { level: "info" },
      {
        write: (line: string) => {
          const record: unknown = JSON.parse(line);
          if (typeof record !== "object" || record === null) return;
          const { module, msg, skill, dir } = record as Record<string, unknown>;
          if (module === "kit/recipes") notes.add(`${String(skill)} (${String(dir)}): ${msg}`);
        },
      },
    ),
  );
  const work = mkdtempSync(join(tmpdir(), "recipe-lever-"));
  try {
    const exit = await Effect.runPromiseExit(inspect(target, work));
    const { locator } = target;
    console.log(
      locator.kind === "git"
        ? `Repository  ${locator.repoUrl} @ ${locator.revision.ref}${locator.subpath === "." ? "" : `, subpath ${locator.subpath}`}`
        : "Repository  the bundled Starter",
    );
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      if (!(error instanceof SyncError)) throw error;
      console.log(`Sync fails  ${error.reason}: ${error.detail ?? error.message}`);
      return 1;
    }
    const report = exit.value;
    if (report.commit)
      console.log(`Commit      ${report.commit}  (${report.listed} entries listed)`);
    else console.log(`Listed      ${report.listed} entries`);
    if (target.tile && report.fixture) {
      console.log(`Tile        ${target.tile.id} (${target.tile.label})`);
      console.log(`  as Tile   ${describe(report.fixture.expect.tile)}`);
      console.log(`  generic   ${describe(report.fixture.expect.generic)}`);
    }
    const { projected } = report;
    if ("notRecognized" in projected) {
      console.log(`Sync fails  not_recognized: ${projected.notRecognized}`);
      for (const note of notes) console.log(`  note: ${note}`);
      return 1;
    }
    const { maxFiles, maxBytes } = DEFAULT_TREE_LIMITS;
    const { recipe } = projected;
    console.log(`Recipe      ${recipe.id} (${recipe.label}, unit ${recipe.unit})`);
    console.log("Capabilities");
    for (const capability of projected.capabilities) {
      console.log(
        `  ${capability.name}  ${capability.files} files  ${megabytes(capability.bytes)}`,
      );
    }
    for (const note of notes) console.log(`  skipped: ${note}`);
    console.log(
      `Ingested    ${projected.files} / ${maxFiles} files, ${projected.bytes} / ${maxBytes} bytes (${megabytes(projected.bytes)})`,
    );
    if (args.record && target.tile && report.fixture) {
      if (!(await writeFixture(target.tile, report.fixture))) return 1;
    }
    if (!args.compareNpx || locator.kind !== "git") return 0;

    const npx = npxSkillNames(locator);
    if (typeof npx === "string") {
      console.log(`npx         ${npx}`);
      return 1;
    }
    const hive = new Set(
      projected.capabilities
        .filter((capability) => capability.name.startsWith("skill/"))
        .map((capability) => capability.name.slice("skill/".length)),
    );
    const listed = new Set(npx.map(sanitizeName));
    const npxOnly = [...listed].filter((name) => !hive.has(name)).sort();
    const hiveOnly = [...hive].filter((name) => !listed.has(name)).sort();
    console.log(`npx         ${SKILLS_CLI} lists ${npx.length}: ${npx.join(", ") || "-"}`);
    console.log(`  npx only:  ${npxOnly.join(", ") || "-"}`);
    console.log(`  Hive only: ${hiveOnly.join(", ") || "-"}`);
    console.log(npxOnly.length + hiveOnly.length === 0 ? "Match" : "MISMATCH");
    return npxOnly.length + hiveOnly.length === 0 ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
