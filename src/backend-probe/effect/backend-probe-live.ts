// Effect-native backend availability probe (mirrors AgentModelPrefsLive,
// ADR-0011). `BackendProbe` is the Context.Service tag; `BackendProbeLive(opts)`
// a stateless layer. The probe is a system diagnostic, so failures go to the
// trace log (the `log()` singleton) — never the audit log (ADR-0004).

import { Context, Layer } from "effect";
import { log } from "../../lib/log.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import {
  bunCommandRunner,
  type CommandRunner,
  DEFAULT_PROBE_TIMEOUT_MS,
  probeBackend,
  type UpdateResult,
  updateBackend,
  updateBinary,
} from "../probe.ts";
import {
  type BackendStatus,
  type BackendUpdateEvents,
  PROBEABLE_BACKENDS,
  type ProbeableBackend,
} from "../types.ts";

export type CreateBackendProbeOptions = {
  // Defaults to the real Bun.spawn runner. Memory mode and tests override it.
  runner?: CommandRunner;
  timeoutMs?: number;
};

export type BackendProbeSvc = {
  probeAll(): Promise<BackendStatus[]>;
  probeOne(backend: ProbeableBackend): Promise<BackendStatus>;
  // Delegate to the backend CLI's OWN self-update command, then re-probe
  // (ADR-0016: Hive detects + delegates, it never installs/manages packages).
  // Returns a TYPED result (ok|failure) — never throws an untyped error. Emits
  // `backend.update.requested` (audit-first) BEFORE running the updater.
  upgrade(backend: ProbeableBackend): Promise<UpdateResult>;
  // Dedicated `backend` AuditSource: the user-triggered delegated-update action.
  events: TypedEmitter<BackendUpdateEvents>;
};

export class BackendProbe extends Context.Service<BackendProbe, BackendProbeSvc>()(
  "backend-probe/BackendProbe",
) {}

// Unhealthy CLIs (present but broken, slow, or version-unreadable) are
// diagnostics worth a trace line. `not_installed` is a normal state and `ok`
// needs no noise.
function traceStatus(status: BackendStatus): void {
  if (status.reason === "ok" || status.reason === "not_installed") return;
  log().warn(
    { module: "backend-probe", backend: status.backend, reason: status.reason },
    "backend probe reported an unhealthy CLI",
  );
}

function buildSvc(runner: CommandRunner, timeoutMs: number): BackendProbeSvc {
  const events = new TypedEmitter<BackendUpdateEvents>();
  const probeOne = async (backend: ProbeableBackend): Promise<BackendStatus> => {
    const status = await probeBackend(backend, runner, { timeoutMs });
    traceStatus(status);
    return status;
  };
  const upgrade = async (backend: ProbeableBackend): Promise<UpdateResult> => {
    // Audit-first: emit the user action BEFORE invoking the CLI's updater
    // (ADR-0004). Refs only — the backend id + the binary NAME, never args/env.
    await events.emit("backend.update.requested", { backend, binary: updateBinary(backend) });
    const result = await updateBackend(backend, runner, { timeoutMs });
    if (result.kind === "ok") traceStatus(result.status);
    return result;
  };
  return {
    events,
    probeOne,
    upgrade,
    probeAll: () => Promise.all(PROBEABLE_BACKENDS.map(probeOne)),
  };
}

export function BackendProbeLive(opts: CreateBackendProbeOptions = {}): Layer.Layer<BackendProbe> {
  return Layer.succeed(
    BackendProbe,
    buildSvc(opts.runner ?? bunCommandRunner, opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
  );
}
