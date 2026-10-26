// The published-skills Recipe (ADR-0033): skills found exactly as
// `npx skills add <repository>` finds them, each copied as that CLI copies a
// skill folder. A port of skills@1.7.2 dist/cli.mjs discoverSkills with no
// subpath and no options, read through RecipeTree only. The recipe-lever
// script's --compare-npx run catches drift from the CLI.

import { Effect } from "effect";
import { log } from "../../lib/log.ts";
import { type TreePath, treePath } from "../acquisition/snapshot.ts";
import type { SyncError } from "../effect/errors.ts";
import { type CapabilityName, type CopyRule, capabilityName, skillFolder } from "./projection.ts";
import type { Match, PickRecipe, RecipeTree } from "./recipe.ts";

// Copied verbatim from skills@1.7.2 dist/cli.mjs.
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__"];
const AGENT_PROJECT_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".cline/skills",
  ".codebuddy/skills",
  ".codex/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".factory/skills",
  ".github/skills",
  ".goose/skills",
  ".grok/skills",
  ".iflow/skills",
  ".junie/skills",
  ".kilo/skills",
  ".kilocode/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".minimax/skills",
  ".mux/skills",
  ".neovate/skills",
  ".opencode/skills",
  ".openhands/skills",
  ".pi/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: copied verbatim from skills@1.7.2
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: copied verbatim from skills@1.7.2
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: copied verbatim from skills@1.7.2
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: copied verbatim from skills@1.7.2
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
const C1_RE = /[\x80-\x9f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: copied verbatim from skills@1.7.2
const CONTROL_RE = /[\x00-\x06\x07\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

function stripTerminalEscapes(str: string): string {
  return str
    .replace(OSC_RE, "")
    .replace(DCS_PM_APC_RE, "")
    .replace(CSI_RE, "")
    .replace(SIMPLE_ESC_RE, "")
    .replace(C1_RE, "")
    .replace(CONTROL_RE, "");
}

function sanitizeMetadata(str: string): string {
  return stripTerminalEscapes(str)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, "-");
}

// The folder name `npx skills add` installs a skill under.
export function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .substring(0, 255) || "unnamed-skill"
  );
}

const ROOT = "" as TreePath;
const join = (dir: TreePath, name: string): TreePath => (dir ? `${dir}/${name}` : name) as TreePath;
// path.join then a containment check: null when the result leaves the root.
const joinContained = (...parts: string[]): TreePath | null =>
  treePath(parts.filter((part) => part !== "").join("/"));
const basename = (dir: TreePath): string => dir.slice(dir.lastIndexOf("/") + 1);

// A property read as JavaScript does it on a parsed JSON value; undefined on a
// primitive. The caller handles null, where JavaScript throws.
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// readLocalLock: any read, parse, or shape failure (including the TypeError a
// null or malformed entry throws there) reads as an empty lock.
function lockedSkillNames(lock: unknown): readonly string[] {
  if (lock === undefined || lock === null) return [];
  const version = field(lock, "version");
  const skills = field(lock, "skills");
  if (typeof version !== "number" || !skills || version < 1) return [];
  for (const entry of Object.values(skills)) {
    if (entry === null || entry === undefined) return [];
    if (field(entry, "sourceType") === "local" && typeof field(entry, "source") !== "string") {
      return [];
    }
  }
  return Object.keys(skills);
}

// getPluginSkillPaths. The CLI scans each manifest inside one try block, so a
// value it would throw a TypeError on ends that manifest's scan and keeps the
// directories found before it.
function pluginSkillPaths(marketplace: unknown, plugin: unknown): TreePath[] {
  const found: TreePath[] = [];
  // False where the CLI throws.
  const addPluginSkillPaths = (pluginBase: TreePath | null, skills: unknown): boolean => {
    if (pluginBase === null) return true;
    if (Array.isArray(skills)) {
      for (const skillPath of skills) {
        if (typeof skillPath !== "string") return false;
        if (!skillPath.startsWith("./")) continue;
        const joined = joinContained(pluginBase, skillPath);
        if (joined === null || joined === "") continue;
        found.push(joined.slice(0, Math.max(0, joined.lastIndexOf("/"))) as TreePath);
      }
    } else if (isRecord(skills)) {
      const length = skills.length;
      if (typeof length === "number" && length > 0) return false;
    }
    found.push(join(pluginBase, "skills"));
    return true;
  };
  const scanMarketplace = (): void => {
    if (marketplace === undefined || marketplace === null) return;
    const pluginRoot = field(field(marketplace, "metadata"), "pluginRoot");
    if (pluginRoot !== undefined && typeof pluginRoot !== "string") return;
    if (pluginRoot !== undefined && !pluginRoot.startsWith("./")) return;
    const plugins = field(marketplace, "plugins") ?? [];
    const list = typeof plugins === "string" ? [...plugins] : plugins;
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (entry === null) return;
      const source = field(entry, "source");
      if (source !== undefined && typeof source !== "string") continue;
      if (source !== undefined && !source.startsWith("./")) continue;
      const base = joinContained(pluginRoot ?? "", source ?? "");
      if (!addPluginSkillPaths(base, field(entry, "skills"))) return;
    }
  };
  scanMarketplace();
  if (plugin !== undefined && plugin !== null) addPluginSkillPaths(ROOT, field(plugin, "skills"));
  return found;
}

type Skill = { readonly dir: TreePath; readonly name: string };

// parseSkillMd: name and description must be non-empty strings, and
// metadata.internal === true is skipped (Hive never sets INSTALL_INTERNAL_SKILLS).
function parseSkillMd(tree: RecipeTree, dir: TreePath): Effect.Effect<Skill | null, SyncError> {
  return tree.frontmatter(join(dir, "SKILL.md")).pipe(
    Effect.map((data) => {
      if (data === null) return null;
      const { name, description, metadata } = data;
      if (typeof name !== "string" || name === "") return null;
      if (typeof description !== "string" || description === "") return null;
      if (isRecord(metadata) && metadata.internal === true) return null;
      return { dir, name: sanitizeMetadata(name) };
    }),
  );
}

function findSkillDirs(tree: RecipeTree, dir: TreePath, depth: number): TreePath[] {
  if (depth > 5) return [];
  const current = tree.kind(join(dir, "SKILL.md")) === "file" ? [dir] : [];
  const below = tree
    .childDirs(dir)
    .filter((name) => !SKIP_DIRS.includes(name))
    .flatMap((name) => findSkillDirs(tree, join(dir, name), depth + 1));
  return [...current, ...below];
}

function discoverSkills(tree: RecipeTree): Effect.Effect<Skill[], SyncError> {
  return Effect.gen(function* () {
    const skills: Skill[] = [];
    const seenNames = new Set<string>();
    const parsedSkillPaths = new Set<TreePath>();
    const locked = new Set(
      lockedSkillNames(yield* tree.json("skills-lock.json" as TreePath)).map(normalizeSkillName),
    );
    const hasSkillMd = (dir: TreePath) => tree.kind(join(dir, "SKILL.md")) === "file";
    const isInstalledProjectSkill = (skill: Skill): boolean => {
      if (locked.size === 0) return false;
      if (
        !AGENT_PROJECT_SKILL_DIRS.some(
          (dir) => skill.dir === dir || skill.dir.startsWith(`${dir}/`),
        )
      ) {
        return false;
      }
      return (
        locked.has(normalizeSkillName(skill.name)) ||
        locked.has(normalizeSkillName(basename(skill.dir)))
      );
    };
    const parseSkillAt = (dir: TreePath): Effect.Effect<Skill | null, SyncError> => {
      if (parsedSkillPaths.has(dir)) return Effect.succeed(null);
      parsedSkillPaths.add(dir);
      return parseSkillMd(tree, dir);
    };
    const take = (skill: Skill) => {
      skills.push(skill);
      seenNames.add(skill.name);
    };

    if (hasSkillMd(ROOT)) {
      const skill = yield* parseSkillAt(ROOT);
      if (skill && !isInstalledProjectSkill(skill)) {
        take(skill);
        return skills;
      }
    }

    const prioritySearchDirs = [
      ROOT,
      "skills",
      "skills/.curated",
      "skills/.experimental",
      "skills/.system",
      ...AGENT_PROJECT_SKILL_DIRS,
    ] as TreePath[];
    const deepContainerDirs = new Set(prioritySearchDirs.slice(1));
    prioritySearchDirs.push(
      ...pluginSkillPaths(
        yield* tree.json(".claude-plugin/marketplace.json" as TreePath),
        yield* tree.json(".claude-plugin/plugin.json" as TreePath),
      ),
    );
    // True when `dir` holds a SKILL.md, whether or not it yields a skill: the
    // walk never descends into it.
    const tryAddSkillAt = (dir: TreePath): Effect.Effect<boolean, SyncError> =>
      Effect.gen(function* () {
        if (!hasSkillMd(dir)) return false;
        const skill = yield* parseSkillAt(dir);
        if (!skill || seenNames.has(skill.name) || isInstalledProjectSkill(skill)) return true;
        take(skill);
        return true;
      });
    const walkSkillDirs = (
      dir: TreePath,
      maxDepth: number,
      depth: number,
    ): Effect.Effect<void, SyncError> =>
      Effect.gen(function* () {
        for (const name of tree.childDirs(dir)) {
          const child = join(dir, name);
          if ((yield* tryAddSkillAt(child)) || depth >= maxDepth || SKIP_DIRS.includes(name)) {
            continue;
          }
          yield* walkSkillDirs(child, maxDepth, depth + 1);
        }
      });
    for (const dir of prioritySearchDirs) {
      yield* walkSkillDirs(dir, deepContainerDirs.has(dir) ? 3 : 1, 1);
    }

    if (skills.length === 0) {
      for (const dir of findSkillDirs(tree, ROOT, 0)) {
        const skill = yield* parseSkillAt(dir);
        if (skill && !seenNames.has(skill.name) && !isInstalledProjectSkill(skill)) take(skill);
      }
    }
    return skills;
  });
}

const PLUGIN_RUNTIME = `\${CLAUDE_PLUGIN_ROOT}`;

const miss = (reason: string): Match => ({ _tag: "Miss", reason });

export const publishedSkills: PickRecipe = {
  id: "published-skills",
  label: "Published skills",
  unit: "pick",
  trust: "generic",
  recognize: (tree) =>
    Effect.gen(function* () {
      const skills = yield* discoverSkills(tree);
      if (skills.length === 0) return miss("no published skills");
      const copies: CopyRule[] = [];
      const folders = new Set<CapabilityName>();
      let needRuntime = 0;
      for (const skill of skills) {
        const context = { module: "kit/recipes", skill: skill.name, dir: skill.dir };
        // The CLI names a skill whose name sanitizes to nothing after the clone's
        // temporary directory, which Hive cannot reproduce for the root skill.
        const raw = skill.name || (skill.dir === ROOT ? "" : basename(skill.dir));
        const name = raw ? capabilityName(sanitizeName(raw)) : null;
        if (!name) {
          log().warn(context, "published skill name is not deployable; skipped");
          continue;
        }
        if (folders.has(name)) {
          log().warn(context, "published skill shares a folder with an earlier one; skipped");
          continue;
        }
        if (yield* tree.mentions(skill.dir, PLUGIN_RUNTIME)) {
          log().info(context, "published skill needs a plugin runtime; skipped");
          needRuntime++;
          continue;
        }
        folders.add(name);
        copies.push({ from: skill.dir, to: skillFolder(name), exclude: "skills-cli" });
      }
      if (copies.length > 0) return { _tag: "Match", projection: { copies, writes: [] } };
      return needRuntime > 0
        ? miss(
            `${needRuntime} published skill${needRuntime === 1 ? " needs" : "s need"} a plugin runtime`,
          )
        : miss("no published skill has a deployable name");
    }),
};
