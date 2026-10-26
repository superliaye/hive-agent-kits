// Recorded Recipe fixtures (ADR-0033). A fixture records, for one Tile's
// repository, every answer recognition read through RecipeTree, the files each
// projected copy rule copies, and two outcomes: recognition with the Tile's
// Recipe and with the generic list alone. Replay answers only from the
// recording, so a Tile's test runs offline, and a Recipe that asks something the
// recording never saw fails until the fixture is re-recorded against the real
// repository with the recipe lever.
//
// Answer keys and values:
//   kind <path>                    "file" | "dir" | "absent"
//   dirs <path>                    childDirs, sorted
//   json <path>                    [] when absent or not JSON, else [value]
//   frontmatter <path>             object, or null
//   mentions <JSON needle> <dir>   boolean
//   copy <exclude> <from>          the copied files, relative to the copy's `to`;
//                                  for a copy of the whole tree, their count and
//                                  the sha256 of the sorted list, because a whole
//                                  repository would not fit in a fixture

import { createHash } from "node:crypto";
import { capabilityLayout } from "@hive/capability-schema";
import { enumerateLeaves, type SourceTree } from "@hive/capability-schema-tools";
import { SelectionUnit } from "@hive/contract";
import { Effect } from "effect";
import { z } from "zod";
import type { TreePath, TreeSnapshot } from "../acquisition/snapshot.ts";
import type { TreeLimits } from "../acquisition/tree-guard.ts";
import type { SyncError } from "../effect/errors.ts";
import { planIngest } from "../mirror.ts";
import { CHECKOUT_ROOT, type CopyRule } from "./projection.ts";
import { type RecipeTree, type Recognition, recipeTree, recognizeSource } from "./recipe.ts";
import type { Tile } from "./tiles.ts";

export const FIXTURE_MAX_BYTES = 64 * 1024;

const Outcome = z.union([
  z
    .object({
      recipe: z.string(),
      unit: SelectionUnit,
      capabilities: z.array(
        z.object({ capability: z.string(), files: z.number().int().positive() }).strict(),
      ),
    })
    .strict(),
  z.object({ notRecognized: z.string() }).strict(),
]);
export type Outcome = z.infer<typeof Outcome>;

export const RecipeFixture = z
  .object({
    tile: z.string(),
    remote: z.object({ repoUrl: z.string(), commit: z.string() }).strict().nullable(),
    answers: z.record(z.string(), z.unknown()),
    expect: z.object({ tile: Outcome, generic: Outcome }).strict(),
  })
  .strict();
export type RecipeFixture = z.infer<typeof RecipeFixture>;

const Kind = z.enum(["file", "dir", "absent"]);
const Names = z.array(z.string());
const Json = z.array(z.unknown()).max(1);
const Frontmatter = z.record(z.string(), z.unknown()).nullable();
const Mentions = z.boolean();
const CopySummary = z
  .object({ files: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const CopyAnswer = z.union([Names, CopySummary]);
type CopyAnswer = z.infer<typeof CopyAnswer>;

const mentionsKey = (dir: TreePath, needle: string) => `mentions ${JSON.stringify(needle)} ${dir}`;
const copyKey = (copy: CopyRule) => `copy ${copy.exclude} ${copy.from}`;

const byKey = ([left]: [string, unknown], [right]: [string, unknown]) =>
  left < right ? -1 : left > right ? 1 : 0;

function recordingTree(live: RecipeTree): {
  tree: RecipeTree;
  answers(): Readonly<Record<string, unknown>>;
} {
  const answers = new Map<string, unknown>();
  const keep = <A>(key: string, answer: A, recorded: unknown = answer): A => {
    answers.set(key, recorded);
    return answer;
  };
  return {
    tree: {
      remote: live.remote,
      kind: (path) => keep(`kind ${path}`, live.kind(path)),
      childDirs: (dir) => {
        const names = live.childDirs(dir);
        return keep(`dirs ${dir}`, names, [...names]);
      },
      json: (path) =>
        live
          .json(path)
          .pipe(
            Effect.map((value) => keep(`json ${path}`, value, value === undefined ? [] : [value])),
          ),
      frontmatter: (path) =>
        live.frontmatter(path).pipe(Effect.map((value) => keep(`frontmatter ${path}`, value))),
      mentions: (dir, needle) =>
        live
          .mentions(dir, needle)
          .pipe(Effect.map((value) => keep(mentionsKey(dir, needle), value))),
    },
    answers: () => Object.fromEntries([...answers].sort(byKey)),
  };
}

// A missing or malformed answer is a defect, not a SyncError: the fixture no
// longer describes what the Recipes ask, so only a re-recording against the real
// repository can say what the answer is. RecipeTree's kind and childDirs are
// synchronous, so they throw; inside recognition that surfaces as a defect.
function recorded(fixture: RecipeFixture) {
  return <A>(key: string, schema: z.ZodType<A>): A => {
    const rerecord = `re-record it with \`bun run recipe-lever ${fixture.tile} --record\` in packages/daemon`;
    if (!Object.hasOwn(fixture.answers, key)) {
      throw new Error(`The ${fixture.tile} fixture has no answer for "${key}"; ${rerecord}`);
    }
    const parsed = schema.safeParse(fixture.answers[key]);
    if (!parsed.success) {
      throw new Error(
        `The ${fixture.tile} fixture's answer for "${key}" is malformed; ${rerecord}`,
      );
    }
    return parsed.data;
  };
}

export function replayTree(fixture: RecipeFixture): RecipeTree {
  const answer = recorded(fixture);
  return {
    remote: fixture.remote,
    kind: (path) => answer(`kind ${path}`, Kind),
    childDirs: (dir) => answer(`dirs ${dir}`, Names),
    json: (path) => Effect.sync(() => answer(`json ${path}`, Json)[0]),
    frontmatter: (path) => Effect.sync(() => answer(`frontmatter ${path}`, Frontmatter)),
    mentions: (dir, needle) => Effect.sync(() => answer(mentionsKey(dir, needle), Mentions)),
  };
}

type CopiedFiles = (copy: CopyRule) => Effect.Effect<CopyAnswer, SyncError>;

// What the Mirror would hold for one copy rule, expanded by the Mirror's own
// planner.
function snapshotCopies(snapshot: TreeSnapshot, limits: TreeLimits): CopiedFiles {
  return (copy) =>
    planIngest(snapshot.entries, { copies: [copy], writes: [] }, limits).pipe(
      Effect.map((plan) => {
        const files = plan.entries.map((entry) =>
          entry.to === copy.to ? "" : entry.to.slice(copy.to.length + 1),
        );
        if (copy.from !== "" || files.length === 0) return files;
        const digest = createHash("sha256").update(files.join("\n")).digest("hex");
        return { files: files.length, digest };
      }),
    );
}

// The Mirror paths as a SourceTree rooted at capabilities/, so the Catalog's
// own walk names the capabilities.
function kitTree(paths: readonly string[]): SourceTree {
  const files = new Set<string>();
  const dirs = new Map<string, Set<string>>([["", new Set()]]);
  for (const path of paths) {
    if (!path.startsWith("capabilities/")) continue;
    const rel = path.slice("capabilities/".length);
    files.add(rel);
    let parent = "";
    for (const segment of rel.split("/")) {
      const children = dirs.get(parent) ?? new Set<string>();
      children.add(segment);
      dirs.set(parent, children);
      parent = parent ? `${parent}/${segment}` : segment;
    }
  }
  return {
    exists: (path) => files.has(path) || dirs.has(path),
    isDir: (path) => dirs.has(path),
    list: (path) => [...(dirs.get(path) ?? [])].sort(),
    read: (path) => (files.has(path) ? "" : null),
  };
}

// Groups Mirror paths by the capability the Catalog would list them under, as
// "<kind>/<name>" ("<kind>/<group>/<name>" inside an @-group), and presets as
// "preset/<name>". A path that belongs to neither is "other/<first two segments>".
export function groupByCapability(
  paths: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const owners = enumerateLeaves(kitTree(paths)).leaves.map((leaf) => {
    const layout = capabilityLayout[leaf.kind];
    const grouped = leaf.group ? `${leaf.group}/` : "";
    const capability = `${leaf.kind}/${grouped}${leaf.name}`;
    return layout.style === "folder"
      ? {
          capability,
          owns: (path: string) =>
            path.startsWith(`capabilities/${layout.dir}/${grouped}${leaf.dir}/`),
        }
      : {
          capability,
          owns: (path: string) => path === `capabilities/${layout.dir}/${leaf.dir}${layout.suffix}`,
        };
  });
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const preset = /^presets\/([^/]+)\.yaml$/.exec(path)?.[1];
    const capability =
      owners.find((owner) => owner.owns(path))?.capability ??
      (preset
        ? `preset/${preset}`
        : path.startsWith(`${CHECKOUT_ROOT}/`)
          ? CHECKOUT_ROOT
          : `other/${path.split("/").slice(0, 2).join("/")}`);
    const group = groups.get(capability);
    if (group) group.push(path);
    else groups.set(capability, [path]);
  }
  return new Map([...groups].sort(byKey));
}

function outcomeOf(
  recognition: Effect.Effect<Recognition, SyncError>,
  copied: CopiedFiles,
): Effect.Effect<Outcome, SyncError> {
  return Effect.gen(function* () {
    const result = yield* Effect.result(recognition);
    if (result._tag === "Failure") {
      if (result.failure.reason !== "not_recognized") return yield* Effect.fail(result.failure);
      return { notRecognized: result.failure.detail ?? result.failure.message };
    }
    const { recipe, projection } = result.success;
    const paths: string[] = projection.writes.map((write) => write.to);
    const summarized: { capability: string; files: number }[] = [];
    for (const copy of projection.copies) {
      const answer = yield* copied(copy);
      if ("files" in answer) {
        // A whole-tree copy lands in one capability folder or the checkout.
        const [capability] = groupByCapability([`${copy.to}/SKILL.md`]).keys();
        summarized.push({ capability: capability ?? copy.to, files: answer.files });
        continue;
      }
      for (const rel of answer) paths.push(rel ? `${copy.to}/${rel}` : copy.to);
    }
    const counts = new Map(
      [...groupByCapability(paths)].map(([capability, files]) => [capability, files.length]),
    );
    for (const { capability, files } of summarized) {
      counts.set(capability, (counts.get(capability) ?? 0) + files);
    }
    const capabilities = [...counts]
      .sort(byKey)
      .map(([capability, files]) => ({ capability, files }));
    return { recipe: recipe.id, unit: recipe.unit, capabilities };
  });
}

export function recordFixture(
  tile: Tile,
  snapshot: TreeSnapshot,
  limits: TreeLimits,
): Effect.Effect<RecipeFixture, SyncError> {
  return Effect.gen(function* () {
    const recording = recordingTree(recipeTree(snapshot, limits));
    const listed = snapshotCopies(snapshot, limits);
    const copies = new Map<string, CopyAnswer>();
    const copied: CopiedFiles = (copy) =>
      listed(copy).pipe(
        Effect.map((files) => {
          copies.set(copyKey(copy), files);
          return files;
        }),
      );
    const tileOutcome = yield* outcomeOf(recognizeSource(recording.tree, tile), copied);
    const generic = yield* outcomeOf(recognizeSource(recording.tree), copied);
    const { remote } = recording.tree;
    return {
      tile: tile.id,
      remote: remote ? { repoUrl: remote.repoUrl, commit: remote.commit } : null,
      answers: Object.fromEntries([...Object.entries(recording.answers()), ...copies].sort(byKey)),
      expect: { tile: tileOutcome, generic },
    };
  });
}

// Recognition from the recording alone: as the Tile's Source, or with the
// generic list when `tile` is null.
export function replayOutcome(
  fixture: RecipeFixture,
  tile: Tile | null,
): Effect.Effect<Outcome, SyncError> {
  const answer = recorded(fixture);
  return outcomeOf(recognizeSource(replayTree(fixture), tile), (copy) =>
    Effect.sync(() => answer(copyKey(copy), CopyAnswer)),
  );
}

const outcomeJson = (outcome: Outcome) =>
  "notRecognized" in outcome
    ? { notRecognized: outcome.notRecognized }
    : {
        recipe: outcome.recipe,
        unit: outcome.unit,
        capabilities: outcome.capabilities.map(({ capability, files }) => ({ capability, files })),
      };

// Fixed field order and sorted answer keys, so re-recording an unchanged
// repository writes identical bytes. Recorded values keep their parsed key
// order, because a Recipe may iterate them.
export function serializeFixture(fixture: RecipeFixture): string {
  const value = {
    tile: fixture.tile,
    remote: fixture.remote && { repoUrl: fixture.remote.repoUrl, commit: fixture.remote.commit },
    answers: Object.fromEntries(Object.entries(fixture.answers).sort(byKey)),
    expect: {
      tile: outcomeJson(fixture.expect.tile),
      generic: outcomeJson(fixture.expect.generic),
    },
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}
