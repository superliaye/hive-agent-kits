// In-memory SourceTree for tests — a plain map of relative path → contents. A
// directory is any path that is a prefix of an entry path; an explicit `null`
// value marks a present-but-unreadable file. Pure: no filesystem access.

import type { SourceTree } from "./source-tree.ts";

export function memTree(files: Record<string, string | null>): SourceTree {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const paths = Object.keys(files).map(norm);

  const isDirPath = (p: string): boolean => {
    const n = norm(p);
    if (n === "") return true;
    return paths.some((f) => f === n || f.startsWith(`${n}/`)) && !(n in files);
  };

  return {
    exists(path: string): boolean {
      const n = norm(path);
      return n in files || isDirPath(n);
    },
    isDir(path: string): boolean {
      return isDirPath(path);
    },
    read(path: string): string | null {
      const n = norm(path);
      if (!(n in files)) return null;
      return files[n] ?? null;
    },
    list(path: string): string[] {
      const n = norm(path);
      const prefix = n === "" ? "" : `${n}/`;
      const names = new Set<string>();
      for (const f of paths) {
        if (n !== "" && !f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (rest.length === 0) continue;
        const first = rest.split("/")[0];
        if (first) names.add(first);
      }
      return [...names];
    },
  };
}
