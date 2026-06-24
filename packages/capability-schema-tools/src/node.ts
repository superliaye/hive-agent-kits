// The single node:fs SourceTree adapter — the one fs-coupled implementation,
// imported by BOTH the CLI bin and the daemon so the swallow-to-empty/null-on-
// error semantics live in exactly one place (no second drifting copy). The pure
// core (the `.` export) stays fs-free; this is the dedicated `./node` subpath.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceTree } from "./source-tree.ts";

export function nodeFsSourceTree(root: string): SourceTree {
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
