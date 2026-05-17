// SSE client. Subscribes to /api/events and invalidates TanStack Query
// caches based on event source.

import type { QueryClient } from "@tanstack/react-query";
import type { ApiConfig } from "./api.ts";

export function startEventStream(cfg: ApiConfig, qc: QueryClient): () => void {
  if (!cfg.token) return () => {};
  const url = `${cfg.baseUrl}/api/events?token=${encodeURIComponent(cfg.token)}`;
  const source = new EventSource(url);

  source.addEventListener("catalog.harness.updated", () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
  });
  source.addEventListener("catalog.agent.created", () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
  });
  source.addEventListener("catalog.agent.destroyed", () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
  });
  source.addEventListener("registry.capability.registered", () => {
    qc.invalidateQueries({ queryKey: ["capabilities"] });
  });
  source.addEventListener("registry.capability.unregistered", () => {
    qc.invalidateQueries({ queryKey: ["capabilities"] });
  });
  source.addEventListener("registry.capability.changed", () => {
    qc.invalidateQueries({ queryKey: ["capabilities"] });
  });

  return () => source.close();
}
