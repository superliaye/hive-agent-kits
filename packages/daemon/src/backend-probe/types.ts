// Backend availability probe — daemon-internal pieces (ADR-0016 "detect, don't
// manage"). The wire schemas (ProbeableBackend, ProbeReasonCode, BackendStatus)
// live in @hive/contract; this module keeps the runtime backend list and the
// audit emitter.

import { ProbeableBackend } from "@hive/contract";

// Re-export the wire enums/schema so backend-probe consumers keep importing them
// from this module alongside the daemon-internal pieces below.
export { BackendStatus, ProbeableBackend, ProbeReasonCode } from "@hive/contract";

export const PROBEABLE_BACKENDS: readonly ProbeableBackend[] = ProbeableBackend.options;

// Audit event for a USER-triggered delegated update (ADR-0004). The probe itself
// is a system diagnostic (trace, not audit); only the user action of asking a CLI
// to self-update is audited. Payload carries REFS only — the backend id + the
// binary NAME invoked (never the full arg vector / env / auth).
export type BackendUpdateEvents = {
  "backend.update.requested": {
    backend: ProbeableBackend;
    /** command[0] of the self-update invocation — a ref (e.g. "claude"). */
    binary: string;
  };
};
