// Audit module types per ADR-0004.

export type ModuleSource =
  | "run"
  | "permission"
  | "secrets"
  | "mcp"
  | "memory"
  | "registry"
  | "catalog"
  | "lifecycle"
  | "backend"
  | "config"
  | "gateway";

export type AuditEvent = {
  id: string;
  // Microseconds since epoch. Computed from `performance.timeOrigin +
  // performance.now()` so two emits inside the same wall-clock millisecond
  // land in distinct ts values.
  ts: number;
  // In-memory monotonic counter, per-Audit-instance. Final tiebreaker when
  // two emits land in the same microsecond. Resets on daemon restart, which
  // is fine because `ts` differs across restarts.
  seq: number;
  run_id: string | null;
  agent_id: string | null;
  source: ModuleSource;
  event_type: string;
  payload: Record<string, unknown>;
  parent_event_id: string | null;
  prev_hash: string | null;
  signature: string | null;
};

// What a per-event normalizer returns. Audit populates id/ts/source/hashes;
// the module provides event_type, payload, and optional run/agent/parent links.
export type NormalizerOutput = {
  event_type: string;
  payload: Record<string, unknown>;
  run_id?: string | null;
  agent_id?: string | null;
  parent_event_id?: string | null;
};

export type Normalizer<TEventMap extends Record<string, unknown>> = {
  [K in keyof TEventMap]: (event: TEventMap[K]) => NormalizerOutput;
};

export type AuditQueryFilter = {
  run_id?: string;
  agent_id?: string;
  source?: ModuleSource;
  event_type?: string;
  since?: number;
  until?: number;
  limit?: number;
};
