// Recipes turn a Source tree into the capability format at Sync (ADR-0033).
// A Recipe sees the tree only through RecipeTree, whose answers are small (a
// kind, a list of names, a parsed object, a boolean), and returns a Projection:
// copy rules and generated files that the Mirror module alone turns into bytes.

import { Buffer } from "node:buffer";
import type { PluginTarget } from "@hive/capability-schema";
import type { RecipeSummary, SelectionUnit } from "@hive/contract";
import { Effect } from "effect";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { log } from "../../lib/log.ts";
import {
  acquisitionError,
  indexTree,
  kindOf,
  realPath,
  type TreePath,
  type TreeSnapshot,
  treePath,
  walkFiles,
} from "../acquisition/snapshot.ts";
import type { TreeLimits } from "../acquisition/tree-guard.ts";
import { SyncError } from "../effect/errors.ts";
import {
  capabilityName,
  type GeneratedFile,
  kitRoot,
  type Projection,
  pluginPointer,
} from "./projection.ts";
import { publishedSkills } from "./published-skills.ts";
import type { Tile } from "./tiles.ts";

// Semantics follow `npx skills add` where a Recipe depends on them:
// - Every path follows the links along it, as opening it would.
// - `childDirs` returns real subdirectories only, sorted.
// - `json` is undefined when the file is absent or not JSON.
// - `frontmatter` is {} when the file has no frontmatter block, null when the
//   file is absent or its YAML does not parse.
// - `mentions` is true when any file a dereferencing copy of `dir` would hold
//   contains `needle`.
// Reads count against the snapshot's byte budget.
export interface RecipeTree {
  // Set only for a whole git repository, because a CLI reads a marketplace from
  // a repository root (ADR-0031).
  readonly remote: { readonly repoUrl: string; readonly commit: string } | null;
  kind(path: TreePath): "file" | "dir" | "absent";
  childDirs(dir: TreePath): readonly string[];
  json(path: TreePath): Effect.Effect<unknown, SyncError>;
  frontmatter(path: TreePath): Effect.Effect<Readonly<Record<string, unknown>> | null, SyncError>;
  mentions(dir: TreePath, needle: string): Effect.Effect<boolean, SyncError>;
}

const FrontmatterObject = z.record(z.string(), z.unknown());

// The block pattern is skills@1.7.2 parseFrontmatter's.
function parseFrontmatter(text: string): Readonly<Record<string, unknown>> | null {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!block) return {};
  try {
    const parsed = FrontmatterObject.safeParse(yamlParse(block[1] ?? ""));
    return parsed.success ? parsed.data : {};
  } catch {
    return null;
  }
}

const READ_BATCH = 128;

export function recipeTree(snapshot: TreeSnapshot, limits: TreeLimits): RecipeTree {
  const index = indexTree(snapshot.entries);
  const origin = snapshot.origin;
  const remote =
    origin.transport === "git" && origin.subpath === "."
      ? { repoUrl: origin.repoUrl, commit: origin.resolvedCommit }
      : origin.transport === "tarball"
        ? { repoUrl: origin.repoUrl, commit: origin.resolvedCommit }
        : null;
  const text = (path: TreePath): Effect.Effect<string | null, SyncError> => {
    const file = realPath(index, path);
    if (file === null || !index.entries.has(file)) return Effect.succeed(null);
    return snapshot
      .read([file])
      .pipe(Effect.map((bytes) => new TextDecoder().decode(bytes.get(file) ?? new Uint8Array())));
  };
  return {
    remote,
    kind: (path) => kindOf(index, path),
    childDirs: (dir) => {
      const real = realPath(index, dir);
      return (real === null ? undefined : index.dirs.get(real))?.dirs ?? [];
    },
    json: (path) =>
      text(path).pipe(
        Effect.map((content) => {
          if (content === null) return undefined;
          try {
            return JSON.parse(content);
          } catch {
            return undefined;
          }
        }),
      ),
    frontmatter: (path) =>
      text(path).pipe(
        Effect.map((content) => (content === null ? null : parseFrontmatter(content))),
      ),
    mentions: (dir, needle) =>
      Effect.gen(function* () {
        const pattern = Buffer.from(needle);
        const files = new Set<TreePath>();
        let walked = 0;
        for (const item of walkFiles(index, dir, () => false)) {
          if (++walked > limits.maxFiles)
            return yield* Effect.fail(acquisitionError("budget_exceeded"));
          if (item._tag === "file") files.add(item.path);
        }
        const paths = [...files];
        for (let start = 0; start < paths.length; start += READ_BATCH) {
          const bytes = yield* snapshot.read(paths.slice(start, start + READ_BATCH));
          for (const data of bytes.values()) {
            if (Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(pattern)) {
              return true;
            }
          }
        }
        return false;
      }),
  };
}

export type Match =
  | { readonly _tag: "Match"; readonly projection: Projection }
  // Short and user-facing: it becomes part of the not_recognized detail.
  | { readonly _tag: "Miss"; readonly reason: string };

type RecipeBase = {
  // Stable: recorded in the Mirror record.
  readonly id: string;
  readonly label: string;
  readonly unit: SelectionUnit;
  // Pure given its port, so the same tree gives the same Match and a re-Sync of
  // an unchanged tree writes identical bytes.
  recognize(tree: RecipeTree): Effect.Effect<Match, SyncError>;
};

// Applies to every Source, a pasted link included, and never runs repository code.
export type GenericRecipe = RecipeBase & { readonly trust: "generic" };
// A generic pattern whose Capabilities the user picks; a Tile may narrow it to whole.
export type PickRecipe = GenericRecipe & { readonly unit: "pick" };
// Covers one repository no generic pattern fits and may run its setup, so only
// a Tile carries one (ADR-0033). Its `trust` keeps it out of GENERIC_RECIPES.
export type RepoRecipe = RecipeBase & { readonly trust: "repo"; readonly unit: "whole" };
export type Recipe = GenericRecipe | RepoRecipe;

export type Recognition = {
  readonly recipe: RecipeSummary;
  readonly projection: Projection;
};

const miss = (reason: string): Match => ({ _tag: "Miss", reason });
const ROOT = "" as TreePath;

// A kit's skills keep the kit rendering at Deploy; every other Recipe's skills
// deploy as their upstream ships them.
export const CAPABILITY_KIT_RECIPE_ID = "capability-kit";

export const capabilityKit: PickRecipe = {
  id: CAPABILITY_KIT_RECIPE_ID,
  label: "Capability kit",
  unit: "pick",
  trust: "generic",
  recognize: (tree) => {
    const roots = tree.childDirs(ROOT);
    if (!roots.includes("capabilities")) return Effect.succeed(miss("no capabilities/ folder"));
    const copies = (["capabilities", "presets"] as const)
      .filter((root) => roots.includes(root))
      .map((root) => ({ from: root as TreePath, to: kitRoot(root), exclude: "none" as const }));
    return Effect.succeed({ _tag: "Match", projection: { copies, writes: [] } });
  },
};

const CLAUDE_MARKETPLACE = ".claude-plugin/marketplace.json" as TreePath;
const CODEX_MARKETPLACE = ".agents/plugins/marketplace.json" as TreePath;

// Lenient on purpose: the CLI, not Hive, decides which `source` forms install.
const Marketplace = z.object({
  name: z.string().min(1),
  plugins: z.array(
    z.object({
      name: z.string().min(1),
      description: z.unknown().optional(),
      source: z.unknown().optional(),
    }),
  ),
});
type Marketplace = z.infer<typeof Marketplace>;

const CodexManifest = z.object({ description: z.string() });
const LocalSource = z.object({ path: z.string() });

type Marketplaces = { claude: Marketplace | null; codex: Marketplace | null };

function readMarketplaces(tree: RecipeTree): Effect.Effect<Marketplaces, SyncError> {
  const read = (path: TreePath) =>
    tree.json(path).pipe(
      Effect.map((value) => {
        const parsed = Marketplace.safeParse(value);
        return parsed.success ? parsed.data : null;
      }),
    );
  return Effect.all({ claude: read(CLAUDE_MARKETPLACE), codex: read(CODEX_MARKETPLACE) });
}

const listsPlugins = (marketplace: Marketplace | null): marketplace is Marketplace =>
  marketplace !== null && marketplace.plugins.length > 0;

function codexDescription(
  tree: RecipeTree,
  source: unknown,
): Effect.Effect<string | undefined, SyncError> {
  const local = LocalSource.safeParse(source);
  const manifest = local.success ? treePath(`${local.data.path}/.codex-plugin/plugin.json`) : null;
  if (manifest === null) return Effect.succeed(undefined);
  return tree.json(manifest).pipe(
    Effect.map((value) => {
      const parsed = CodexManifest.safeParse(value);
      return parsed.success ? parsed.data.description : undefined;
    }),
  );
}

// One pointer per listed plugin. `targets` are the files that list it, and
// `source_commit` moves the pointer's ContentSha with every synced commit, which
// is what surfaces a pending update.
function pluginPointers(
  tree: RecipeTree,
  remote: NonNullable<RecipeTree["remote"]>,
  marketplaceName: string,
  { claude, codex }: Marketplaces,
): Effect.Effect<Projection, SyncError> {
  return Effect.gen(function* () {
    const listed = new Map<string, { targets: PluginTarget[]; description: string | undefined }>();
    for (const plugin of claude?.plugins ?? []) {
      const description = typeof plugin.description === "string" ? plugin.description : undefined;
      listed.set(plugin.name, { targets: ["claude"], description });
    }
    for (const plugin of codex?.plugins ?? []) {
      const entry = listed.get(plugin.name);
      if (entry?.targets.includes("codex")) continue;
      const description = entry?.description ?? (yield* codexDescription(tree, plugin.source));
      if (entry) {
        entry.targets.push("codex");
        entry.description = description;
      } else {
        listed.set(plugin.name, { targets: ["codex"], description });
      }
    }
    const writes: GeneratedFile[] = [];
    for (const [raw, plugin] of listed) {
      const name = capabilityName(raw);
      if (!name) {
        log().warn({ module: "kit/recipes", plugin: raw }, "invalid plugin name; skipped");
        continue;
      }
      const frontmatter = yamlStringify({
        description: plugin.description || name,
        marketplace_source: remote.repoUrl,
        marketplace_name: marketplaceName,
        plugin_name: name,
        targets: plugin.targets,
        source_commit: remote.commit,
      });
      writes.push({ to: pluginPointer(name), text: `---\n${frontmatter}---\n` });
    }
    return { copies: [], writes };
  });
}

export const pluginMarketplace: PickRecipe = {
  id: "plugin-marketplace",
  label: "Plugin marketplace",
  unit: "pick",
  trust: "generic",
  recognize: (tree) =>
    Effect.gen(function* () {
      const { remote } = tree;
      if (!remote) return miss("not a whole git repository");
      const marketplaces = yield* readMarketplaces(tree);
      const { claude, codex } = marketplaces;
      if (!listsPlugins(claude) || !listsPlugins(codex)) {
        return miss("no marketplace for both CLIs");
      }
      if (claude.name !== codex.name) return miss("marketplace names differ");
      const projection = yield* pluginPointers(tree, remote, claude.name, marketplaces);
      return { _tag: "Match", projection } satisfies Match;
    }),
};

const singleCliMarketplace: PickRecipe = {
  id: "single-cli-marketplace",
  label: "Single-CLI plugin marketplace",
  unit: "pick",
  trust: "generic",
  recognize: (tree) =>
    Effect.gen(function* () {
      const { remote } = tree;
      if (!remote) return miss("not a whole git repository");
      const { claude, codex } = yield* readMarketplaces(tree);
      const listing = listsPlugins(claude) ? claude : listsPlugins(codex) ? codex : null;
      if (!listing) return miss("no plugin marketplace");
      const other = listing === claude ? codex : claude;
      if (other && other.name !== listing.name) return miss("marketplace names differ");
      const marketplaces =
        listing === claude ? { claude: listing, codex: null } : { claude: null, codex: listing };
      const projection = yield* pluginPointers(tree, remote, listing.name, marketplaces);
      return { _tag: "Match", projection } satisfies Match;
    }),
};

// The one ordered list of generic patterns (ADR-0033). Published skills come
// before singleCliMarketplace, so a repository that ships skills and a
// single-CLI marketplace serves both CLIs.
const GENERIC_RECIPES: readonly GenericRecipe[] = [
  capabilityKit,
  pluginMarketplace,
  publishedSkills,
  singleCliMarketplace,
];

const DETAIL_LIMIT = 160;

function clip(detail: string): string {
  return detail.length <= DETAIL_LIMIT ? detail : `${detail.slice(0, DETAIL_LIMIT - 1)}…`;
}

function notRecognizedDetail(reasons: readonly string[]): string {
  return clip(`No Recipe matched: ${[...new Set(reasons)].join("; ")}`);
}

// A Tile's Source runs exactly that Tile's Recipe and never falls back to the
// generic list: a generic pattern can match a repository its Tile rejects
// (gstack's router-only root skill). Any other Source, the default, runs
// GENERIC_RECIPES in order and takes the first Match.
export function recognizeSource(
  tree: RecipeTree,
  tile: Tile | null = null,
): Effect.Effect<Recognition, SyncError> {
  return Effect.gen(function* () {
    const recipes: readonly Recipe[] = tile ? [tile.recipe] : GENERIC_RECIPES;
    const reasons: string[] = [];
    for (const recipe of recipes) {
      const result = yield* recipe.recognize(tree);
      if (result._tag === "Match") {
        return {
          recipe: { id: recipe.id, label: recipe.label, unit: recipe.unit },
          projection: result.projection,
        };
      }
      reasons.push(result.reason);
    }
    const detail = tile
      ? clip(`no longer matches the ${tile.label} Tile: ${reasons.join("; ")}`)
      : notRecognizedDetail(reasons);
    return yield* Effect.fail(new SyncError({ reason: "not_recognized", message: detail, detail }));
  });
}
