// The TreeSnapshot port: the one view of a Source tree that recognition and the
// Mirror materializer read. Every Source kind lists its tree before any read and
// reads bytes on demand; no snapshot writes anything.

import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { SyncError } from "../effect/errors.ts";
import { parseTar, topFolder } from "../tar.ts";

declare const treePathBrand: unique symbol;
// A POSIX path relative to the Source's selected root (its subpath); "" is the
// root. Listings build them after their safety checks, so none holds "..", ".",
// an empty segment, a backslash, or a leading "/".
export type TreePath = string & { readonly [treePathBrand]: true };

// Links are resolved once, at listing: `target` is the in-tree file or directory
// the link finally names, or null when it dangles or leaves the selected tree.
export type TreeEntry =
  | { readonly mode: "file" | "exec" }
  | { readonly mode: "link"; readonly target: TreePath | null };

export const TreeOrigin = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("git"),
    repoUrl: z.string(),
    requestedRevision: z.union([
      z.object({ mode: z.literal("track"), ref: z.string() }),
      z.object({ mode: z.literal("pin"), commit: z.string() }),
    ]),
    resolvedCommit: z.string().regex(/^[0-9a-f]{40}$/),
    subpath: z.string(),
    treeIdentity: z.string().min(1),
  }),
  z.object({
    transport: z.literal("working-tree"),
    repoRoot: z.string(),
    subpath: z.string(),
    head: z.string().regex(/^[0-9a-f]{40}$/),
    dirty: z.boolean(),
  }),
  z.object({ transport: z.literal("bundled") }),
  // The memory-mode GitHub HTTP fixture: a codeload tarball at a resolved commit.
  z.object({
    transport: z.literal("tarball"),
    repoUrl: z.string(),
    resolvedCommit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
]);
export type TreeOrigin = z.infer<typeof TreeOrigin>;

// Invariants:
// - `entries` is complete for the selected subpath and is listed before any blob
//   is read.
// - `read` takes listed file paths only, returns raw bytes, and fails
//   `budget_exceeded` once the bytes read pass the byte limit.
// - `confirm` proves everything read so far came from one snapshot. Only the
//   working tree can change under a read; the other kinds are immutable.
export interface TreeSnapshot {
  readonly origin: TreeOrigin;
  readonly entries: ReadonlyMap<TreePath, TreeEntry>;
  read(paths: readonly TreePath[]): Effect.Effect<ReadonlyMap<TreePath, Uint8Array>, SyncError>;
  confirm(): Effect.Effect<void, SyncError>;
}

export type ListedEntry =
  | { readonly mode: "file" | "exec" }
  | { readonly mode: "link"; readonly text: string };

// Normalizes a relative path such as "./plugins/ye/" to a TreePath, or null when
// it is absolute or leaves the root.
export function treePath(raw: string): TreePath | null {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0") || /^[A-Za-z]:/.test(raw)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/") as TreePath;
}

const MAX_LINK_HOPS = 40;

// Resolves every link against the listing, component by component like
// realpath, so a link through another link lands on what the filesystem would
// open. Anything outside the listing reads as dangling.
export function resolveListing(
  listed: ReadonlyMap<TreePath, ListedEntry>,
): Map<TreePath, TreeEntry> {
  const directories = new Set<string>([""]);
  for (const path of listed.keys()) {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      directories.add(path.slice(0, slash));
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  const resolveLink = (linkPath: string, text: string, hops: number): string | null => {
    if (hops > MAX_LINK_HOPS || text.startsWith("/") || text.includes("\\")) return null;
    if (text.includes("\0") || /^[A-Za-z]:/.test(text)) return null;
    const parent = linkPath.includes("/") ? linkPath.slice(0, linkPath.lastIndexOf("/")) : "";
    let resolved: string[] = parent ? parent.split("/") : [];
    for (const segment of text.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (resolved.length === 0) return null;
        resolved.pop();
        continue;
      }
      resolved.push(segment);
      const prefix = resolved.join("/");
      const entry = listed.get(prefix as TreePath);
      if (entry?.mode === "link") {
        const next = resolveLink(prefix, entry.text, hops + 1);
        if (next === null) return null;
        resolved = next ? next.split("/") : [];
      }
    }
    const target = resolved.join("/");
    return listed.has(target as TreePath) || directories.has(target) ? target : null;
  };
  const entries = new Map<TreePath, TreeEntry>();
  for (const [path, entry] of listed) {
    entries.set(
      path,
      entry.mode === "link"
        ? { mode: "link", target: resolveLink(path, entry.text, 0) as TreePath | null }
        : { mode: entry.mode },
    );
  }
  return entries;
}

type TreeDir = { readonly dirs: readonly string[]; readonly leaves: readonly string[] };

// The listing as directories, each with its subdirectories and its leaves
// (files and links) by name, sorted. A directory exists only as the ancestor of a
// listed entry.
export type TreeIndex = {
  readonly entries: ReadonlyMap<TreePath, TreeEntry>;
  readonly dirs: ReadonlyMap<string, TreeDir>;
};

export function indexTree(entries: ReadonlyMap<TreePath, TreeEntry>): TreeIndex {
  const building = new Map<string, { dirs: Set<string>; leaves: string[] }>([
    ["", { dirs: new Set(), leaves: [] }],
  ]);
  for (const path of entries.keys()) {
    const segments = path.split("/");
    let parent = "";
    for (const segment of segments.slice(0, -1)) {
      const dir = parent ? `${parent}/${segment}` : segment;
      building.get(parent)?.dirs.add(segment);
      if (!building.has(dir)) building.set(dir, { dirs: new Set(), leaves: [] });
      parent = dir;
    }
    building.get(parent)?.leaves.push(segments[segments.length - 1] ?? "");
  }
  const dirs = new Map<string, TreeDir>();
  for (const [dir, node] of building) {
    dirs.set(dir, { dirs: [...node.dirs].sort(), leaves: node.leaves.sort() });
  }
  return { entries, dirs };
}

const childOf = (dir: string, name: string): TreePath =>
  (dir ? `${dir}/${name}` : name) as TreePath;

// Follows every link along `path`, as opening it would; null when one dangles or
// leaves the tree. The result may name nothing.
export function realPath(index: TreeIndex, path: TreePath): TreePath | null {
  if (path === "") return path;
  let real = "";
  for (const segment of path.split("/")) {
    const next = childOf(real, segment);
    const entry = index.entries.get(next);
    if (entry?.mode !== "link") real = next;
    else if (entry.target === null) return null;
    else real = entry.target;
  }
  return real as TreePath;
}

export function kindOf(index: TreeIndex, path: TreePath): "file" | "dir" | "absent" {
  const real = realPath(index, path);
  if (real === null) return "absent";
  if (index.entries.has(real)) return "file";
  return index.dirs.has(real) ? "dir" : "absent";
}

type WalkItem =
  | {
      readonly _tag: "file";
      // Relative to the walked root; "" when the root is itself a file.
      readonly rel: string;
      readonly path: TreePath;
      readonly mode: "file" | "exec";
    }
  | { readonly _tag: "dropped"; readonly path: TreePath; readonly reason: string };

const isAncestorOrSelf = (dir: string, of: string): boolean =>
  dir === "" || of === dir || of.startsWith(`${dir}/`);

// Every file at or under `root` as a dereferencing copy (`cp -L`) writes it: a
// link to a file is that file, and a link to a directory is that directory's
// files under the link's path. `exclude` sees each name the walk reaches in the
// directories it walks itself, never under a linked directory, which is copied
// whole. A dangling link, a link out of the tree, and a link to a directory that
// holds the walk or the link (which would copy itself forever) are dropped.
export function* walkFiles(
  index: TreeIndex,
  root: TreePath,
  exclude: (name: string, isDirectory: boolean) => boolean,
): Generator<WalkItem> {
  const real = realPath(index, root);
  if (real === null) return;
  const entry = index.entries.get(real);
  if (entry) {
    if (entry.mode !== "link") yield { _tag: "file", rel: "", path: real, mode: entry.mode };
    return;
  }
  if (index.dirs.has(real)) yield* walkDir(index, real, "", [real], exclude);
}

const keepAll = () => false;

function* walkDir(
  index: TreeIndex,
  dir: string,
  prefix: string,
  holding: readonly string[],
  exclude: (name: string, isDirectory: boolean) => boolean,
): Generator<WalkItem> {
  const node = index.dirs.get(dir);
  if (!node) return;
  for (const name of node.leaves) {
    if (exclude(name, false)) continue;
    const path = childOf(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const entry = index.entries.get(path);
    if (!entry) continue;
    if (entry.mode !== "link") {
      yield { _tag: "file", rel, path, mode: entry.mode };
      continue;
    }
    const target = entry.target;
    if (target === null) {
      yield { _tag: "dropped", path, reason: "link dangles or leaves the tree" };
      continue;
    }
    const linked = index.entries.get(target);
    if (linked && linked.mode !== "link") {
      yield { _tag: "file", rel, path: target, mode: linked.mode };
    } else if (
      isAncestorOrSelf(target, path) ||
      holding.some((held) => isAncestorOrSelf(target, held))
    ) {
      yield { _tag: "dropped", path, reason: "link loops back into the copy" };
    } else {
      yield* walkDir(index, target, rel, [...holding, target], keepAll);
    }
  }
  for (const name of node.dirs) {
    if (exclude(name, true)) continue;
    yield* walkDir(
      index,
      childOf(dir, name),
      prefix ? `${prefix}/${name}` : name,
      holding,
      exclude,
    );
  }
}

const ACQUISITION_DETAILS = {
  offline: "repository fetch failed",
  auth_or_repository_unavailable: "repository access failed",
  invalid_locator: "source locator is invalid",
  missing_ref: "requested revision is unavailable",
  invalid_subpath: "selected subpath is unavailable",
  timeout: "source acquisition timed out",
  budget_exceeded: "selected tree exceeds acquisition limits",
  unsafe_tree: "selected tree is unsafe",
  working_tree_not_allowed: "working tree is not allowed",
  working_tree_changed: "working tree changed during capture",
  io: "source acquisition failed",
} as const;

export type AcquisitionCode = keyof typeof ACQUISITION_DETAILS;

// Acquisition failures carry only these fixed details, never Git stderr, URLs,
// or paths.
export function acquisitionError(code: AcquisitionCode): SyncError {
  const detail = ACQUISITION_DETAILS[code];
  return new SyncError({ reason: code, message: detail, detail });
}

function readFiles(
  paths: readonly TreePath[],
  bytesOf: (path: TreePath) => Uint8Array | undefined,
): Effect.Effect<ReadonlyMap<TreePath, Uint8Array>, SyncError> {
  return Effect.try({
    try: () => {
      const out = new Map<TreePath, Uint8Array>();
      for (const path of paths) {
        const bytes = bytesOf(path);
        if (!bytes) throw new Error("unlisted path");
        out.set(path, bytes);
      }
      return out;
    },
    catch: () => acquisitionError("io"),
  });
}

export function missingLocalRoot(): SyncError {
  const detail = "local content root is unavailable";
  return new SyncError({ reason: "missing_local_root", message: detail, detail });
}

// A local directory listed once. Serves the `fixture-` Sources, so an absent
// root is a missing local root.
export function directorySnapshot(root: string): Effect.Effect<TreeSnapshot, SyncError> {
  return Effect.try({
    try: () => {
      if (!statSync(root).isDirectory()) throw new Error("not a directory");
      const listed = new Map<TreePath, ListedEntry>();
      const walk = (directory: string, prefix: string): void => {
        for (const dirent of readdirSync(directory, { withFileTypes: true })) {
          const path = prefix ? `${prefix}/${dirent.name}` : dirent.name;
          const absolute = join(directory, dirent.name);
          if (dirent.isDirectory()) walk(absolute, path);
          else if (dirent.isSymbolicLink()) {
            listed.set(path as TreePath, { mode: "link", text: readlinkSync(absolute) });
          } else if (dirent.isFile()) {
            const exec = (statSync(absolute).mode & 0o111) !== 0;
            listed.set(path as TreePath, { mode: exec ? "exec" : "file" });
          }
        }
      };
      walk(root, "");
      return resolveListing(listed);
    },
    catch: missingLocalRoot,
  }).pipe(
    Effect.map(
      (entries): TreeSnapshot => ({
        origin: { transport: "bundled" },
        entries,
        read: (paths) =>
          readFiles(paths, (path) =>
            entries.get(path)?.mode === "link" || !entries.has(path)
              ? undefined
              : readFileSync(join(root, path)),
          ),
        confirm: () => Effect.void,
      }),
    ),
  );
}

function safeArchivePath(path: string): boolean {
  return (
    !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

// The memory-mode codeload tarball as a snapshot, so its tests run the one Sync
// path. Unsafe and special entries are skipped, as the old tar writer did.
export function tarSnapshot(
  tar: Uint8Array,
  repoUrl: string,
  sha: string,
): Effect.Effect<TreeSnapshot, SyncError> {
  return Effect.try({
    try: () => parseTar(tar),
    catch: () =>
      new SyncError({
        reason: "parse",
        message: "tarball parse failed",
        detail: "tarball parse failed",
      }),
  }).pipe(
    Effect.map((archive): TreeSnapshot => {
      const strip = topFolder(archive);
      const listed = new Map<TreePath, ListedEntry>();
      const bytes = new Map<TreePath, Uint8Array>();
      for (const entry of archive) {
        const path =
          strip && entry.path.startsWith(`${strip}/`)
            ? entry.path.slice(strip.length + 1)
            : entry.path;
        if (!path || !safeArchivePath(path)) continue;
        if (entry.type === "file") {
          listed.set(path as TreePath, { mode: (entry.mode & 0o111) !== 0 ? "exec" : "file" });
          bytes.set(path as TreePath, entry.data);
        } else if (entry.type === "symlink") {
          listed.set(path as TreePath, { mode: "link", text: entry.linkTarget });
        }
      }
      return {
        origin: { transport: "tarball", repoUrl, resolvedCommit: sha },
        entries: resolveListing(listed),
        read: (paths) => readFiles(paths, (path) => bytes.get(path)),
        confirm: () => Effect.void,
      };
    }),
  );
}
