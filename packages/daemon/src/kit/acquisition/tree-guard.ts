// `maxFiles` bounds the ingested set, not the listed tree. `maxBytes` bounds
// every byte a git or working-tree snapshot reads, recognition included.
// `maxListedEntries` only guards memory.
export type TreeLimits = {
  maxFiles: number;
  maxBytes: number;
  timeoutMs: number;
  maxListedEntries: number;
};

export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxFiles: 20_000,
  maxBytes: 268_435_456,
  timeoutMs: 120_000,
  maxListedEntries: 200_000,
};
