// The single node:fs SourceTree adapter — the one fs-coupled implementation,
// imported by BOTH the CLI bin and the daemon so the swallow-to-empty/null-on-
// error semantics live in exactly one place (no second drifting copy). The pure
// core (the `.` export) stays fs-free; this is the dedicated `./node` subpath.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceTree } from "./source-tree.ts";

// The convention for rooting a SourceTree at a Source repo: its capability bytes
// live under `<repoRoot>/capabilities`. This is the ONLY exported way to build a
// node:fs SourceTree, so the `capabilities/` rooting can't be bypassed — the raw
// non-appending primitive below is module-private. The argument is ALWAYS a repo
// root, NEVER an already-`capabilities/`-suffixed path — `capabilities/` is
// unconditionally appended. Pass a suffixed path and the tree roots at
// `<x>/capabilities/capabilities` (an empty tree → falsely conformant).
export function capabilitiesRoot(repoRoot: string): SourceTree {
  return nodeFsSourceTree(join(repoRoot, "capabilities"));
}

// Module-private: the low-level fs primitive with NO `capabilities/` rooting. Build
// a SourceTree only via `capabilitiesRoot` so the rooting convention has one home.
function nodeFsSourceTree(root: string): SourceTree {
  const abs = (p: string): string => join(root, p);
  return {
    exists(path: string): boolean {
      return existsSync(abs(path));
    },
    list(path: string): string[] {
      try {
        return readdirSync(abs(path));
      } catch {
        return [];
      }
    },
    read(path: string): string | null {
      try {
        return readFileSync(abs(path), "utf8");
      } catch {
        return null;
      }
    },
    isDir(path: string): boolean {
      try {
        return statSync(abs(path)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
