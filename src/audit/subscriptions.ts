// Wire-up of module event streams → Audit, per ADR-0004.
// Each emitter module adds one line here when it ships. v1 starts empty —
// audit lands before any emitter exists. Adds:
//   disposers.push(audit.attach("run", runEvents, runNormalizer));
//   disposers.push(audit.attach("permission", permissionEvents, permissionNormalizer));
//   ... etc.
//
// Reading this file gives the full graph of who feeds the audit log.

import type { Audit } from "./index.ts";

export function wireSubscriptions(audit: Audit): () => void {
  const disposers: Array<() => void> = [];
  // No subscriptions yet — modules will register here as they land.
  void audit;
  return () => {
    for (const d of disposers) d();
  };
}
