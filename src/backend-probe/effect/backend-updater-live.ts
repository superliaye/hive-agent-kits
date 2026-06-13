// Effect-native delegated CLI self-update (ADR-0016: Hive detects + delegates,
// it never installs/manages packages). `BackendUpdater` is the sibling service
// to `BackendProbe` — kept SEPARATE so `probeBackend`'s documented purity and
// the probe service's read-only surface stay intact (OQ-5): the `upgrade` verb
// lives here, NOT on `BackendProbeSvc`.
//
// The updater reuses the same `CommandRunner` port as the probe (one runner
// injection shape, so memory mode/tests stay consistent) to run a backend's OWN
// self-update command, then delegates the re-probe to `BackendProbe.probeOne`.
// The user-triggered update action is audited (subscribe pattern, ADR-0004): the
// service owns a `backend.update.requested` emitter the Audit module attaches to.

import { Context, Effect, Layer } from "effect";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import {
  bunCommandRunner,
  type CommandRunner,
  DEFAULT_UPDATE_TIMEOUT_MS,
  runUpdateCommand,
  type UpdateResult,
  updateBinary,
} from "../probe.ts";
import type { BackendUpdateEvents, ProbeableBackend } from "../types.ts";
import { BackendProbe, type BackendProbeSvc } from "./backend-probe-live.ts";

export type CreateBackendUpdaterOptions = {
  // Defaults to the real Bun.spawn runner — the SAME default as the probe.
  // Memory mode and tests override it (kept in lockstep with the probe runner).
  runner?: CommandRunner;
  timeoutMs?: number;
};

export type BackendUpdaterSvc = {
  // Delegate to the backend CLI's OWN self-update command, then re-probe via
  // `BackendProbe.probeOne` (OQ-5: the re-probe is the probe service's job, not
  // duplicated here). Returns a TYPED result (ok|failure) — never throws an
  // untyped error. Emits `backend.update.requested` (audit-first) BEFORE running
  // the updater.
  upgrade(backend: ProbeableBackend): Promise<UpdateResult>;
  // Dedicated `backend` AuditSource: the user-triggered delegated-update action.
  events: TypedEmitter<BackendUpdateEvents>;
};

export class BackendUpdater extends Context.Service<BackendUpdater, BackendUpdaterSvc>()(
  "backend-probe/BackendUpdater",
) {}

function buildSvc(
  runner: CommandRunner,
  timeoutMs: number,
  probe: BackendProbeSvc,
): BackendUpdaterSvc {
  const events = new TypedEmitter<BackendUpdateEvents>();
  const upgrade = async (backend: ProbeableBackend): Promise<UpdateResult> => {
    // Audit-first: emit the user action BEFORE invoking the CLI's updater
    // (ADR-0004). Refs only — the backend id + the binary NAME, never args/env.
    await events.emit("backend.update.requested", { backend, binary: updateBinary(backend) });
    const outcome = await runUpdateCommand(backend, runner, { timeoutMs });
    if (outcome.kind !== "ok") return outcome;
    // Re-probe through the probe service — the single authority on backend status.
    return { kind: "ok", status: await probe.probeOne(backend) };
  };
  return { events, upgrade };
}

// Depends on `BackendProbe` (the re-probe authority). The updater's own runner
// is injected the same way the probe's is — the composition root passes the same
// runner to both so a memory-mode probe and updater agree.
export function BackendUpdaterLive(
  opts: CreateBackendUpdaterOptions = {},
): Layer.Layer<BackendUpdater, never, BackendProbe> {
  return Layer.effect(
    BackendUpdater,
    Effect.gen(function* () {
      const probe = yield* BackendProbe;
      return buildSvc(
        opts.runner ?? bunCommandRunner,
        opts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
        probe,
      );
    }),
  );
}
