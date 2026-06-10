// Public API for the Threads module.
//
// Implementation is Effect-native (`ThreadsLive`, ADR-0011 Phase 4); consumers
// resolve the `Threads` service off the root `ManagedRuntime` (`createServer()`).
// `ThreadsLive` builds the store over the shared root `HiveDb` connection (no
// second sqlite handle). This barrel re-exports the legacy `Threads` type alias
// (the `ServerHandles.threads` / routes surface), the throwing
// `ThreadNotFoundError`, and the row/input types. The legacy `createThreads()`
// proxy was removed in §4.x — its last consumer was `createServer()`, now wired
// through `ThreadsLive`.

import type { ThreadsStore } from "./store.ts";

export type Threads = ThreadsStore;

export { AUTO_ARCHIVE_IDLE_DAYS, AUTO_ARCHIVE_IDLE_MS, autoArchiveSweep } from "./auto-archive.ts";
export type { ThreadStatus } from "./status.ts";
export { deriveThreadStatus } from "./status.ts";
export type { AppendMessageInput, CreateThreadInput } from "./store.ts";
export { ThreadNotFoundError } from "./store.ts";
export type { MaybeGenerateTitleDeps } from "./title.ts";
export { maybeGenerateTitle } from "./title.ts";
export type {
  Thread,
  ThreadEvents,
  ThreadMessage,
  ThreadWithMessages,
  TitleSource,
} from "./types.ts";
