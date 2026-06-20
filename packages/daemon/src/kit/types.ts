// Kit daemon-internal types. The wire types live in `@hive/contract`; this file
// retains only what never crosses the wire: the deploy audit emitter and the
// on-disk mirror provenance.

import { z } from "zod";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { DeployTarget } from "./targets.ts";

// Mirror provenance recorded next to the synced tree (on-disk only — not a wire
// type).
export const MirrorProvenance = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-hex SHA"),
  fetchedAt: z.number().int(),
});
export type MirrorProvenance = z.infer<typeof MirrorProvenance>;

// ---- Audit event (source: 'deploy') ----

export type DeployAuditEvents = {
  "deploy.applied": {
    kitSha: string | null;
    perKindCounts: Record<string, number>;
    targetClis: DeployTarget[];
  };
};

export type KitEventEmitter = TypedEmitter<DeployAuditEvents>;
