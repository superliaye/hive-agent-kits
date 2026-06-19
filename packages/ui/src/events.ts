// The daemon no longer exposes an /api/events SSE channel (removed in the
// agent-system teardown). Kit sync/deploy freshness is poll-based: views drive
// refresh via react-query invalidation, not server-pushed events.
//
// This stays a no-op so main.tsx keeps a stable mount/unmount lifecycle hook
// to wire future event streaming into without touching the composition root.

import type { QueryClient } from "@tanstack/react-query";
import type { ApiConfig } from "./api.ts";

export function startEventStream(_cfg: ApiConfig, _qc: QueryClient): () => void {
  return () => {};
}
