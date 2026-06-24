// The SourceTree read-port — a consumer-owned, synchronous interface over a
// Source repo's bytes. Paths are relative to the Source repo root. Sync because
// the daemon's catalog read is fully synchronous; an async port would be
// speculative generality for a remote tree that does not exist (ADR-0024).
//
// `exists` is deliberately separate from `read`: the leaf-vs-@-group decision
// keys off marker *presence*, and a present-but-unreadable marker is a located
// problem, not a fall-through to @-group recursion. Inferring presence from
// `read() !== null` would make an unreadable marker indistinguishable from an
// absent one and silently recurse the dir as a group.

export interface SourceTree {
  // True iff the path is present (file or dir).
  exists(path: string): boolean;
  // Dir entry names; [] if missing or not a dir.
  list(path: string): string[];
  // utf8 contents; null if missing or unreadable.
  read(path: string): string | null;
  // True iff the path is a directory.
  isDir(path: string): boolean;
}
