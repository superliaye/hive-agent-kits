import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseTar, type TarEntry } from "../tar.ts";

export type TreeLimits = {
  maxFiles: number;
  maxBytes: number;
  timeoutMs: number;
};

export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxFiles: 20_000,
  maxBytes: 268_435_456,
  timeoutMs: 120_000,
};

export class TreeGuardError extends Error {
  override readonly name = "TreeGuardError";
  constructor(
    readonly code: "budget_exceeded" | "timeout" | "unsafe_tree" | "io",
    message: string,
  ) {
    super(message);
  }
}

function escapes(root: string, relativePath: string, allowRoot = false): boolean {
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.includes("\\")) {
    return true;
  }
  const destination = resolve(root, relativePath);
  const resolvedRoot = resolve(root);
  return (
    (!allowRoot && destination === resolvedRoot) ||
    (destination !== resolvedRoot && !destination.startsWith(resolvedRoot + sep))
  );
}

function relativeEntryPath(stage: string, path: string): string {
  const relativePath = path.replace(/^\.\//, "");
  if (
    !relativePath ||
    relativePath.split("/").some((segment) => segment === "." || segment === "..") ||
    escapes(stage, relativePath)
  ) {
    throw new TreeGuardError("unsafe_tree", "archive contains an unsafe path");
  }
  return relativePath;
}

function validateEntries(
  entries: readonly TarEntry[],
  stage: string,
  limits: Pick<TreeLimits, "maxFiles" | "maxBytes">,
  checkDeadline: () => void,
): void {
  let files = 0;
  let bytes = 0;
  const paths = new Set<string>();
  for (const entry of entries) {
    checkDeadline();
    const relativePath = relativeEntryPath(stage, entry.path);
    if (paths.has(relativePath)) {
      throw new TreeGuardError("unsafe_tree", "archive contains duplicate paths");
    }
    paths.add(relativePath);
    if (entry.type === "special") {
      throw new TreeGuardError("unsafe_tree", "archive contains a special file");
    }
    if (entry.type === "dir") continue;

    files++;
    bytes += entry.data.byteLength;
    if (files > limits.maxFiles || bytes > limits.maxBytes) {
      throw new TreeGuardError("budget_exceeded", "selected tree exceeds acquisition limits");
    }
    if (
      entry.type === "symlink" &&
      (isAbsolute(entry.linkTarget) ||
        /^[A-Za-z]:/.test(entry.linkTarget) ||
        entry.linkTarget.includes("\\") ||
        escapes(stage, join(dirname(relativePath), entry.linkTarget), true))
    ) {
      throw new TreeGuardError("unsafe_tree", "archive contains a link outside the selected tree");
    }
  }
}

/** Materialize a validated git archive without following archive-controlled links. */
export function extractBoundedTree(
  tar: Uint8Array,
  stage: string,
  limits: Pick<TreeLimits, "maxFiles" | "maxBytes">,
  deadlineMs?: number,
): void {
  const checkDeadline = () => {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new TreeGuardError("timeout", "git acquisition timed out");
    }
  };
  const entries = parseTar(tar, checkDeadline);
  validateEntries(entries, stage, limits, checkDeadline);

  for (const entry of entries) {
    checkDeadline();
    if (entry.type !== "dir") continue;
    mkdirSync(join(stage, relativeEntryPath(stage, entry.path)), { recursive: true });
  }
  for (const entry of entries) {
    checkDeadline();
    if (entry.type !== "file") continue;
    const destination = join(stage, relativeEntryPath(stage, entry.path));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.data);
    chmodSync(destination, entry.mode & 0o777);
  }
  for (const entry of entries) {
    checkDeadline();
    if (entry.type !== "symlink") continue;
    const destination = join(stage, relativeEntryPath(stage, entry.path));
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(entry.linkTarget, destination);
  }
}
