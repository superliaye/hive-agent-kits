// The single leaf-enumeration primitive. Both `parse` (lenient) and `validate`
// (strict) consume this — they differ only in how they MAP each LeafHit, never
// in how they FIND leaves, so the tree walk is single-sourced (no divergent
// second walk in the package). Pure: drives off `capabilityLayout` over the
// SourceTree port; no filesystem access.

import { type CapabilityKind, capabilityLayout } from "@hive/capability-schema";
import type { SourceTree } from "./source-tree.ts";

// A located capability leaf. `dir` is the innermost marker-holding directory name
// (the flattened leaf, e.g. `my-commit` for skills/@my/my-commit/) — never an
// @-group ancestor. `group` is the @-group ancestor chain (`@my`), display only.
// `markerContent` is the marker/file bytes, or null when present-but-unreadable
// (the caller decides what to do).
export interface LeafHit {
  kind: CapabilityKind;
  name: string;
  group: string;
  dir: string;
  markerContent: string | null;
}

// A located problem surfaced by the walk (kept distinct from a leaf): a marker
// that exists but is unreadable. Mirrors the daemon's `unreadable ${marker}`
// located problem — the dir is NOT recursed as a group in that case.
export interface WalkProblem {
  kind: string;
  name: string;
  problem: string;
}

export interface WalkResult {
  leaves: LeafHit[];
  problems: WalkProblem[];
}

// Join relative SourceTree path segments with forward slashes (pure; not fs).
function join(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

export function enumerateLeaves(tree: SourceTree): WalkResult {
  const leaves: LeafHit[] = [];
  const problems: WalkProblem[] = [];

  for (const kind of Object.keys(capabilityLayout) as CapabilityKind[]) {
    const layout = capabilityLayout[kind];
    if (layout.style === "folder") {
      collectFolderKind(tree, kind, layout.dir, layout.marker, leaves, problems);
    } else {
      collectFileKind(tree, kind, layout.dir, layout.suffix, leaves, problems);
    }
  }

  return { leaves, problems };
}

function collectFolderKind(
  tree: SourceTree,
  kind: CapabilityKind,
  kindDir: string,
  marker: string,
  leaves: LeafHit[],
  problems: WalkProblem[],
): void {
  for (const entry of tree.list(kindDir)) {
    if (entry.startsWith(".")) continue;
    const full = join(kindDir, entry);
    if (!tree.isDir(full)) continue;
    // Top-level entry: its own name is `entry`, no ancestor group yet.
    collectFolderEntries(tree, full, entry, "", kind, marker, leaves, problems);
  }
}

// A dir holding the marker IS a leaf (name = dirName, group = groupPath). A
// marker-less dir is an @-group ancestor — its name extends the group path for
// its children.
function collectFolderEntries(
  tree: SourceTree,
  dir: string,
  dirName: string,
  groupPath: string,
  kind: CapabilityKind,
  marker: string,
  leaves: LeafHit[],
  problems: WalkProblem[],
): void {
  const markerFile = join(dir, marker);
  if (tree.exists(markerFile)) {
    const content = tree.read(markerFile);
    if (content === null) {
      // Present-but-unreadable marker: a located problem, NOT a fall-through to
      // @-group recursion.
      problems.push({ kind, name: dirName, problem: `unreadable ${marker}` });
      return;
    }
    leaves.push({ kind, name: dirName, group: groupPath, dir: dirName, markerContent: content });
    return;
  }
  // Grouping folder: its name extends the group path for its children.
  const childGroup = groupPath ? `${groupPath}/${dirName}` : dirName;
  for (const child of tree.list(dir)) {
    if (child.startsWith(".")) continue;
    const childFull = join(dir, child);
    if (!tree.isDir(childFull)) continue;
    collectFolderEntries(tree, childFull, child, childGroup, kind, marker, leaves, problems);
  }
}

// File-marker kinds (instruction/plugin/bundle): one file per capability, named
// `<leaf><suffix>`. A directory whose name ends in the suffix is ignored.
function collectFileKind(
  tree: SourceTree,
  kind: CapabilityKind,
  kindDir: string,
  suffix: string,
  leaves: LeafHit[],
  problems: WalkProblem[],
): void {
  for (const entry of tree.list(kindDir)) {
    if (entry.startsWith(".") || !entry.endsWith(suffix)) continue;
    const full = join(kindDir, entry);
    if (tree.isDir(full)) continue;
    const name = entry.slice(0, entry.length - suffix.length);
    const content = tree.read(full);
    if (content === null) {
      problems.push({ kind, name, problem: "unreadable" });
      continue;
    }
    leaves.push({ kind, name, group: "", dir: name, markerContent: content });
  }
}
