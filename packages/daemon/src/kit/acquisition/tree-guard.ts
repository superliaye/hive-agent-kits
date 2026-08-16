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
