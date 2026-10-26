// Kit daemon-internal types. The wire types live in `@hive/contract`; this file
// retains only what never crosses the wire: the deploy audit emitter.

import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { DeployTarget } from "./targets.ts";

// ---- Audit event (source: 'deploy') ----

export type DeployAuditEvents = {
  "deploy.accepted": {
    operationId: string;
    selectionRevision: number;
    perKindActionCounts: Record<string, number>;
    targetClis: DeployTarget[];
  };
  "selection.changed": {
    revision: number;
    addedPerKind: Record<string, number>;
    removedPerKind: Record<string, number>;
    targetClis: DeployTarget[];
  };
};

export type KitEventEmitter = TypedEmitter<DeployAuditEvents>;
