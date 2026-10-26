// What a Recipe returns: copy rules and generated files over Mirror paths that
// only the constructors below can build. The Mirror module alone turns a
// Projection into bytes.

import { NAME_PATTERN } from "@hive/capability-schema";
import type { TreePath } from "../acquisition/snapshot.ts";

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

export function skillFolder(name: CapabilityName): MirrorPath {
  return `capabilities/skills/${name}` as MirrorPath;
}

export function pluginPointer(name: CapabilityName): MirrorPath {
  return `capabilities/plugins/${name}.plugin.md` as MirrorPath;
}

export function bundlePointer(name: CapabilityName): MirrorPath {
  return `capabilities/bundles/${name}.bundle.md` as MirrorPath;
}

// The repository tree a repo-specific Recipe's commands run in (ADR-0034).
// Deploy copies it out to a durable checkout; nothing runs in the Mirror.
export const CHECKOUT_ROOT = "checkout" as MirrorPath;

// "skills-cli" leaves out what skills@1.7.2 copyDirectory leaves out: any entry
// named metadata.json, and the directories .git, __pycache__, and __pypackages__.
export type ExcludeRule = "none" | "skills-cli";

const SKILLS_CLI_EXCLUDED_FILES = new Set(["metadata.json"]);
const SKILLS_CLI_EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

export function excludes(rule: ExcludeRule, name: string, isDirectory: boolean): boolean {
  if (rule === "none") return false;
  return SKILLS_CLI_EXCLUDED_FILES.has(name) || (isDirectory && SKILLS_CLI_EXCLUDED_DIRS.has(name));
}

// Copies `from` (a file, or every entry under a directory) to `to`.
export type CopyRule = {
  readonly from: TreePath;
  readonly to: MirrorPath;
  readonly exclude: ExcludeRule;
};
// UTF-8, mode 0644.
export type GeneratedFile = { readonly to: MirrorPath; readonly text: string };

// No two rules may write the same path or one inside another; planIngest treats
// a violation as a Recipe defect.
export type Projection = {
  readonly copies: readonly CopyRule[];
  readonly writes: readonly GeneratedFile[];
};
