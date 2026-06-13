// Effect-native backend availability probe (mirrors AgentModelPrefsLive,
// ADR-0011). `BackendProbe` is the Context.Service tag; `BackendProbeLive(opts)`
// a stateless layer. The probe is a system diagnostic, so failures go to the
// trace log (the `log()` singleton) — never the audit log (ADR-0004).

import { Context, Layer } from "effect";
import { log } from "../../lib/log.ts";
import {
  bunCommandRunner,
  type CommandRunner,
  DEFAULT_PROBE_TIMEOUT_MS,
  probeBackend,
} from "../probe.ts";
import { type BackendStatus, PROBEABLE_BACKENDS, type ProbeableBackend } from "../types.ts";

export type CreateBackendProbeOptions = {
  // Defaults to the real Bun.spawn runner. Memory mode and tests override it.
  runner?: CommandRunner;
  timeoutMs?: number;
};

// Read-only probe surface. The delegated-update verb lives on the sibling
// `BackendUpdaterSvc` (OQ-5) — NOT here — so this service and `probeBackend`
// stay pure detection.
export type BackendProbeSvc = {
  probeAll(): Promise<BackendStatus[]>;
  probeOne(backend: ProbeableBackend): Promise<BackendStatus>;
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
  const probeOne = async (backend: ProbeableBackend): Promise<BackendStatus> => {
    const status = await probeBackend(backend, runner, { timeoutMs });
    traceStatus(status);
    return status;
  };
  return {
    probeOne,
    probeAll: () => Promise.all(PROBEABLE_BACKENDS.map(probeOne)),
  };
}

export function BackendProbeLive(opts: CreateBackendProbeOptions = {}): Layer.Layer<BackendProbe> {
  return Layer.succeed(
    BackendProbe,
    buildSvc(opts.runner ?? bunCommandRunner, opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
  );
}
