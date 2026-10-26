// Recipes turn a Source tree into the capability format at Sync (ADR-0033).
// A Recipe sees the tree only through RecipeTree, whose answers are small (a
// kind, a list of names, a parsed object, a boolean), and returns a Projection:
// copy rules and generated files that the Mirror module alone turns into bytes.

import { Buffer } from "node:buffer";
import { NAME_PATTERN, type PluginTarget } from "@hive/capability-schema";
import type { RecipeSummary, SelectionUnit } from "@hive/contract";
import { Effect } from "effect";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { log } from "../../lib/log.ts";
import { type TreePath, type TreeSnapshot, treePath } from "../acquisition/snapshot.ts";
import { SyncError } from "../effect/errors.ts";

// Semantics follow `npx skills add` where a Recipe depends on them:
// - `kind` follows a link for its last segment.
// - `childDirs` returns real subdirectories only, sorted.
// - `json` is undefined when the file is absent or not JSON.
// - `frontmatter` is {} when the file has no frontmatter block, null when the
//   file is absent or its YAML does not parse.
// - `mentions` is true when any file at or under `dir` contains `needle`.
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

function parseFrontmatter(text: string): Readonly<Record<string, unknown>> | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) return {};
  try {
    const parsed = FrontmatterObject.safeParse(yamlParse(block[1] ?? ""));
    return parsed.success ? parsed.data : {};
  } catch {
    return null;
  }
}

const READ_BATCH = 128;

export function recipeTree(snapshot: TreeSnapshot): RecipeTree {
  const children = new Map<string, Set<string>>([["", new Set()]]);
  for (const path of snapshot.entries.keys()) {
    const segments = path.split("/");
    let parent = "";
    for (const segment of segments.slice(0, -1)) {
      const dir = parent ? `${parent}/${segment}` : segment;
      children.get(parent)?.add(segment);
      if (!children.has(dir)) children.set(dir, new Set());
      parent = dir;
    }
  }
  const origin = snapshot.origin;
  const remote =
    origin.transport === "git" && origin.subpath === "."
      ? { repoUrl: origin.repoUrl, commit: origin.resolvedCommit }
      : origin.transport === "tarball"
        ? { repoUrl: origin.repoUrl, commit: origin.resolvedCommit }
        : null;
  const fileOf = (path: TreePath): TreePath | null => {
    const entry = snapshot.entries.get(path);
    if (!entry) return null;
    if (entry.mode !== "link") return path;
    const target = entry.target === null ? undefined : snapshot.entries.get(entry.target);
    return target && target.mode !== "link" ? entry.target : null;
  };
  const text = (path: TreePath): Effect.Effect<string | null, SyncError> => {
    const file = fileOf(path);
    if (file === null) return Effect.succeed(null);
    return snapshot
      .read([file])
      .pipe(Effect.map((bytes) => new TextDecoder().decode(bytes.get(file) ?? new Uint8Array())));
  };
  return {
    remote,
    kind: (path) => {
      const entry = snapshot.entries.get(path);
      if (entry?.mode === "link") {
        if (entry.target === null) return "absent";
        if (snapshot.entries.has(entry.target)) return "file";
        return children.has(entry.target) ? "dir" : "absent";
      }
      if (entry) return "file";
      return children.has(path) ? "dir" : "absent";
    },
    childDirs: (dir) => [...(children.get(dir) ?? [])].sort(),
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
        const files = [
          ...new Set(
            [...snapshot.entries.keys()]
              .filter((path) => dir === "" || path === dir || path.startsWith(`${dir}/`))
              .map(fileOf)
              .filter((path): path is TreePath => path !== null),
          ),
        ];
        for (let start = 0; start < files.length; start += READ_BATCH) {
          const bytes = yield* snapshot.read(files.slice(start, start + READ_BATCH));
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

declare const capabilityNameBrand: unique symbol;
// A leaf name that passes NAME_PATTERN and the 64-char bound.
export type CapabilityName = string & { readonly [capabilityNameBrand]: true };

export function capabilityName(raw: string): CapabilityName | null {
  return raw.length <= 64 && NAME_PATTERN.test(raw) ? (raw as CapabilityName) : null;
}

declare const mirrorPathBrand: unique symbol;
// A path inside a Mirror. Only the constructors below build one, so a Recipe
// cannot write outside the folders Catalog and Deploy read, and cannot traverse.
export type MirrorPath = string & { readonly [mirrorPathBrand]: true };

export function kitRoot(root: "capabilities" | "presets"): MirrorPath {
  return root as MirrorPath;
}

export function pluginPointer(name: CapabilityName): MirrorPath {
  return `capabilities/plugins/${name}.plugin.md` as MirrorPath;
}

// Copies `from` (a file, or every entry under a directory) to `to`.
export type CopyRule = { readonly from: TreePath; readonly to: MirrorPath };
// UTF-8, mode 0644.
export type GeneratedFile = { readonly to: MirrorPath; readonly text: string };

// No two rules may write the same path or one inside another; planIngest treats
// a violation as a Recipe defect.
export type Projection = {
  readonly copies: readonly CopyRule[];
  readonly writes: readonly GeneratedFile[];
};

export type Match =
  | { readonly _tag: "Match"; readonly projection: Projection }
  // Short and user-facing: it becomes part of the not_recognized detail.
  | { readonly _tag: "Miss"; readonly reason: string };

export type Recipe = {
  // Stable: recorded in the Mirror record.
  readonly id: string;
  readonly label: string;
  readonly unit: SelectionUnit;
  // Pure given its port, so the same tree gives the same Match and a re-Sync of
  // an unchanged tree writes identical bytes.
  recognize(tree: RecipeTree): Effect.Effect<Match, SyncError>;
};

// Applies to every Source, a pasted link included, and never runs repository code.
export type GenericRecipe = Recipe & { readonly trust: "generic" };

export type Recognition = {
  readonly recipe: RecipeSummary;
  readonly projection: Projection;
};

const miss = (reason: string): Match => ({ _tag: "Miss", reason });
const ROOT = "" as TreePath;

const capabilityKit: GenericRecipe = {
  id: "capability-kit",
  label: "Capability kit",
  unit: "pick",
  trust: "generic",
  recognize: (tree) => {
    const roots = tree.childDirs(ROOT);
    if (!roots.includes("capabilities")) return Effect.succeed(miss("no capabilities/ folder"));
    const copies = (["capabilities", "presets"] as const)
      .filter((root) => roots.includes(root))
      .map((root) => ({ from: root as TreePath, to: kitRoot(root) }));
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

const pluginMarketplace: GenericRecipe = {
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

const singleCliMarketplace: GenericRecipe = {
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

// The one ordered list of generic patterns (ADR-0033). The published-skills
// pattern belongs between pluginMarketplace and singleCliMarketplace, so a
// repository that ships skills and a single-CLI marketplace serves both CLIs.
const GENERIC_RECIPES: readonly GenericRecipe[] = [
  capabilityKit,
  pluginMarketplace,
  singleCliMarketplace,
];

const DETAIL_LIMIT = 160;

function notRecognizedDetail(reasons: readonly string[]): string {
  const detail = `No Recipe matched: ${[...new Set(reasons)].join("; ")}`;
  return detail.length <= DETAIL_LIMIT ? detail : `${detail.slice(0, DETAIL_LIMIT - 1)}…`;
}

// Runs GENERIC_RECIPES in order and takes the first Match.
export function recognizeSource(tree: RecipeTree): Effect.Effect<Recognition, SyncError> {
  return Effect.gen(function* () {
    const reasons: string[] = [];
    for (const recipe of GENERIC_RECIPES) {
      const result = yield* recipe.recognize(tree);
      if (result._tag === "Match") {
        return {
          recipe: { id: recipe.id, label: recipe.label, unit: recipe.unit },
          projection: result.projection,
        };
      }
      reasons.push(result.reason);
    }
    const detail = notRecognizedDetail(reasons);
    return yield* Effect.fail(new SyncError({ reason: "not_recognized", message: detail, detail }));
  });
}
