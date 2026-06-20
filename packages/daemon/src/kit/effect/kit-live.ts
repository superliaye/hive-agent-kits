// Effect-native Kit module (Plan A6/A7/A8). The Context.Service tag + Layer that
// owns the deploy-target port, the HTTP fetch, the exec/probe adapter, and the
// deploy audit emitter. Discharges its own dependencies at the module boundary —
// the composition root provides nothing but the mode-driven options.

import type {
  Catalog,
  DeployDiff,
  DeployResult,
  KitState,
  Selection,
  SyncStatus,
  VerifyReport,
} from "@hive/contract";
import { Context, Effect, Layer } from "effect";
import { log } from "../../lib/log.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { readCatalog } from "../catalog.ts";
import {
  type BinaryProbe,
  bunBinaryProbe,
  bunExec,
  type DeployFsExec,
  type ExecPort,
} from "../deploy/adapter.ts";
import { type DeployInput, runDeploy } from "../deploy/engine.ts";
import { readLedger } from "../ledger.ts";
import { mirrorExists, readProvenance, recoverMirror, sweepStaleTmp } from "../mirror.ts";
import { computeDiff, resolveSelection } from "../selection.ts";
import { type HttpFetch, productionFetch, runSync, type SyncOutcome } from "../sync.ts";
import { type DeployTargets, defaultDeployTargets } from "../targets.ts";
import type { DeployAuditEvents } from "../types.ts";
import { runVerify } from "../verify.ts";
import { DeployError, SyncError } from "./errors.ts";

export type KitSvc = {
  // Read the catalog from the Mirror (resilient; problems surfaced).
  catalog(): Catalog;
  // Current sync + ledger state.
  state(): KitState;
  // Run a sync; returns the diff-from-deployed delta state via state() after.
  sync(): Effect.Effect<SyncOutcome, SyncError>;
  // Compute the Deploy Diff for a Selection.
  diff(selection: Selection): Effect.Effect<DeployDiff, DeployError>;
  // On-disk self-check: per-capability per-target status (present/missing/drifted/
  // recorded). Read-only — emits no audit row.
  verify(): VerifyReport;
  // Apply a Selection. Emits exactly one `deploy.applied` audit event.
  deploy(selection: Selection): Effect.Effect<DeployResult, DeployError>;
  // Audit source emitter (source: 'deploy').
  events: TypedEmitter<DeployAuditEvents>;
};

export type CreateKitOptions = {
  // Override the deploy-target port (tests inject a redirected one). Defaults to
  // the env-overridable production port.
  targets?: DeployTargets;
  // Override the HTTP fetch (tests inject offline/403/fixture). Defaults to global fetch.
  fetch?: HttpFetch;
  // Override exec/probe (tests assert the installer is/isn't called).
  exec?: ExecPort;
  probe?: BinaryProbe;
};

// Build the last-sync status. A failed/rate-limited check is surfaced distinctly
// and never reports "up to date".
function buildSyncStatus(
  targets: DeployTargets,
  lastError: { reason: string; rateLimitReset?: number } | null,
): SyncStatus {
  const prov = readProvenance(targets);
  if (lastError) {
    return {
      state: lastError.reason === "rate_limited" ? "rate_limited" : "check_failed",
      sha: prov?.sha ?? null,
      fetchedAt: prov?.fetchedAt ?? null,
      errorReason: lastError.reason,
      ...(lastError.rateLimitReset !== undefined
        ? { rateLimitReset: lastError.rateLimitReset }
        : {}),
    };
  }
  return {
    state: prov ? "up_to_date" : "check_failed",
    sha: prov?.sha ?? null,
    fetchedAt: prov?.fetchedAt ?? null,
    ...(prov ? {} : { errorReason: "no_mirror" }),
  };
}

function buildSvc(opts: CreateKitOptions): KitSvc {
  const targets = opts.targets ?? defaultDeployTargets();
  const fetchImpl = opts.fetch ?? productionFetch();
  const fx: DeployFsExec = {
    targets,
    exec: opts.exec ?? bunExec,
    probe: opts.probe ?? bunBinaryProbe,
  };
  const events = new TypedEmitter<DeployAuditEvents>();

  // Last sync error, for the freshness state surfaced by state().
  let lastSyncError: { reason: string; rateLimitReset?: number } | null = null;

  return {
    events,
    catalog: () =>
      mirrorExists(targets) ? readCatalog(targets) : { entries: [], presets: [], problems: [] },
    state: () => ({ sync: buildSyncStatus(targets, lastSyncError), ledger: readLedger(targets) }),
    verify: () => runVerify(targets),
    sync: () =>
      runSync(targets, fetchImpl).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            lastSyncError = null;
          }),
        ),
        Effect.tapError((err: SyncError) =>
          Effect.sync(() => {
            lastSyncError = {
              reason: err.reason,
              ...(err.rateLimitReset !== undefined ? { rateLimitReset: err.rateLimitReset } : {}),
            };
          }),
        ),
      ),
    diff: (selection) =>
      Effect.try({
        try: () => {
          const catalog = readCatalog(targets);
          const resolved = resolveSelection(catalog, selection);
          return computeDiff(targets, catalog, resolved);
        },
        catch: (err) =>
          err instanceof DeployError
            ? err
            : new DeployError({ reason: "io", message: `diff failed: ${String(err)}` }),
      }),
    deploy: (selection) =>
      Effect.gen(function* () {
        const catalog = readCatalog(targets);
        const resolved = yield* Effect.try({
          try: () => resolveSelection(catalog, selection),
          catch: (err) =>
            err instanceof DeployError
              ? err
              : new DeployError({ reason: "io", message: String(err) }),
        });
        const prov = readProvenance(targets);
        const input: DeployInput = {
          selection: resolved,
          kitSha: prov?.sha ?? null,
          kitVersion: prov?.sha ?? "",
        };
        const result = yield* runDeploy(fx, input);
        // Exactly one audit event, refs-only allow-list payload.
        const perKindCounts: Record<string, number> = {};
        for (const k of result.perKind) perKindCounts[k.kind] = k.applied.length;
        yield* Effect.promise(() =>
          events.emit("deploy.applied", {
            kitSha: result.kitSha,
            perKindCounts,
            targetClis: result.targets,
          }),
        );
        return result;
      }),
  };
}

export class Kit extends Context.Service<Kit, KitSvc>()("kit/Kit") {}

export function KitLive(opts: CreateKitOptions = {}): Layer.Layer<Kit> {
  return Layer.effect(
    Kit,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const svc = buildSvc(opts);
        const targets = opts.targets ?? defaultDeployTargets();
        // Startup disk maintenance, modeled as an explicit I/O edge (not folded
        // into the pure service construction): recover a crash-interrupted mirror
        // swap and sweep stale temp + leftover backups. An fs fault is contained,
        // never a Layer-build defect.
        yield* Effect.sync(() => {
          try {
            recoverMirror(targets);
            sweepStaleTmp(targets);
          } catch (err) {
            log().warn({ module: "kit", err: String(err) }, "kit startup maintenance failed");
          }
        });
        return svc;
      }),
      () => Effect.void,
    ),
  );
}
