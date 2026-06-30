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
  Source,
  SyncRunResult,
  VerifyReport,
} from "@hive/contract";
import { Context, Effect, Layer } from "effect";
import { log } from "../../lib/log.ts";
import { TypedEmitter } from "../../lib/typed-emitter.ts";
import { SourceRegistry, type SourceRegistrySvc } from "../../sources/effect/sources-live.ts";
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
import { recoverMirror, sweepStaleTmp } from "../mirror.ts";
import { catalogNameSets, computeDiff, resolveSelection } from "../selection.ts";
import { type HttpFetch, localSyncSource, productionFetch, syncSource } from "../sync.ts";
import { buildSourceSyncStatus, type LastSyncError } from "../sync-status.ts";
import { type DeployTargets, failSafeDeployTargets } from "../targets.ts";
import type { DeployAuditEvents } from "../types.ts";
import { runVerify } from "../verify.ts";
import { DeployError, SyncError } from "./errors.ts";

export type KitSvc = {
  // Read the catalog from the Mirror (resilient; problems surfaced).
  catalog(): Catalog;
  // Current sync + ledger state (per-Source freshness array).
  state(): KitState;
  // Run a per-Source sync over the active Sources; one Source's failure never
  // fails the whole run. Returns the per-Source outcomes.
  sync(): Effect.Effect<SyncRunResult>;
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

function activeSources(registry: SourceRegistrySvc): readonly Source[] {
  return registry.currentSources().filter((s) => s.active);
}

function buildSvc(opts: CreateKitOptions, registry: SourceRegistrySvc): KitSvc {
  const targets = opts.targets ?? failSafeDeployTargets();
  const fetchImpl = opts.fetch ?? productionFetch();
  const fx: DeployFsExec = {
    targets,
    exec: opts.exec ?? bunExec,
    probe: opts.probe ?? bunBinaryProbe,
  };
  const events = new TypedEmitter<DeployAuditEvents>();

  // Per-Source last sync error, keyed by Source id. A Map so a lookup miss is a
  // clean `undefined` under noUncheckedIndexedAccess — never an `as`.
  const lastSyncError = new Map<string, LastSyncError>();

  // Active-Source mirror roots for a captured snapshot, in registry order — used
  // for SNIPPET loading only (snippets aren't Capabilities, so they have no
  // winner). Each Capability's winner Mirror travels in the resolved selection.
  // Derive both the catalog input and the mirror roots from ONE snapshot per verb
  // so a concurrent registry mutation can't make them diverge mid-operation.
  const mirrorRootsOf = (active: readonly Source[]): readonly string[] =>
    active.map((s) => targets.mirrorRoot(s.id));

  return {
    events,
    catalog: () => readCatalog(targets, activeSources(registry)),
    state: () => ({
      sync: activeSources(registry).map((s) =>
        buildSourceSyncStatus(s, targets.mirrorRoot(s.id), lastSyncError.get(s.id)),
      ),
      ledger: readLedger(targets),
    }),
    verify: () => runVerify(targets),
    sync: () =>
      Effect.gen(function* () {
        const sources = activeSources(registry);
        const outcomes = yield* Effect.forEach(
          sources,
          (source) =>
            Effect.gen(function* () {
              // Branch on the Source kind — the ONE consumer that must differ
              // between local and git. A local Source copies the bundled Starter
              // (no fetch); a git Source syncs over the network. A local failure
              // is a per-source SyncError VALUE in `E` (recorded in that Source's
              // status), never a thrown defect — a raw throw in this Effect.forEach
              // loop would sink every Source and could crash boot.
              // Both branches normalize to a common `{ status }` so the
              // conditional is one Effect type, not a union (Effect.result can't
              // infer over a two-arm Effect union). The git path's provenance is
              // unused here — only the status reaches the run result.
              const syncEffect: Effect.Effect<{ status: "synced" | "unchanged" }, SyncError> =
                source.kind === "local"
                  ? localSyncSource(
                      targets.mirrorRoot(source.id),
                      targets.kitTmpRoot(),
                      targets.starterRoot(),
                    )
                  : syncSource(
                      targets.mirrorRoot(source.id),
                      targets.kitTmpRoot(),
                      source.origin,
                      fetchImpl,
                    ).pipe(Effect.map((o) => ({ status: o.status })));
              const result = yield* Effect.result(syncEffect);
              if (result._tag === "Success") {
                lastSyncError.delete(source.id);
                return {
                  sourceId: source.id,
                  origin: source.origin,
                  status: result.success.status,
                } satisfies SyncRunResult["sources"][number];
              }
              const err: SyncError = result.failure;
              lastSyncError.set(source.id, {
                reason: err.reason,
                ...(err.rateLimitReset !== undefined ? { rateLimitReset: err.rateLimitReset } : {}),
              });
              return {
                sourceId: source.id,
                origin: source.origin,
                status: "failed",
                errorReason: err.reason,
                ...(err.rateLimitReset !== undefined ? { rateLimitReset: err.rateLimitReset } : {}),
              } satisfies SyncRunResult["sources"][number];
            }),
          { concurrency: 1 },
        );
        return { sources: outcomes };
      }),
    diff: (selection) =>
      Effect.try({
        try: () => {
          const active = activeSources(registry);
          const catalog = readCatalog(targets, active);
          const resolved = resolveSelection(catalog, selection);
          // #47: only an owned name still in the active catalog can be "removed".
          return computeDiff(targets, mirrorRootsOf(active), resolved, catalogNameSets(catalog));
        },
        catch: (err) =>
          err instanceof DeployError
            ? err
            : new DeployError({ reason: "io", message: `diff failed: ${String(err)}` }),
      }),
    deploy: (selection) =>
      Effect.gen(function* () {
        const active = activeSources(registry);
        const catalog = readCatalog(targets, active);
        const resolved = yield* Effect.try({
          try: () => resolveSelection(catalog, selection),
          catch: (err) =>
            err instanceof DeployError
              ? err
              : new DeployError({ reason: "io", message: String(err) }),
        });
        // The multi-Source world has no single kit SHA: the deploy audit kitSha
        // and the interop Ledger kitVersion are retired unconditionally (both
        // N==1 and N>1). The resolved selection carries each name's winner Source,
        // so the only mirror roots threaded are the active set for snippet loading.
        // The active-catalog name-set lets reconcilePrune keep owned-but-absent
        // orphans instead of unlinking them (#47).
        const activeNames = catalogNameSets(catalog);
        const input: DeployInput = {
          selection: resolved,
          kitSha: null,
          kitVersion: "",
          activeMirrorRoots: mirrorRootsOf(active),
          activeCatalogNames: {
            skills: [...activeNames.skills],
            agents: [...activeNames.agents],
          },
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

// KitLive requires SourceRegistry. Kit cannot self-satisfy it: the Sources routes
// must share the SAME store instance, so the composition root provides the one
// shared registry layer (Effect memoizes a Layer by reference). Leaking the
// SourceRegistry requirement to the root is correct here, not an AGENTS.md
// discharge-at-the-boundary violation.
export function KitLive(opts: CreateKitOptions = {}): Layer.Layer<Kit, never, SourceRegistry> {
  return Layer.effect(
    Kit,
    Effect.gen(function* () {
      const registry = yield* SourceRegistry;
      const svc = buildSvc(opts, registry);
      const targets = opts.targets ?? failSafeDeployTargets();
      // Startup disk maintenance, modeled as an explicit I/O edge: recover a
      // crash-interrupted mirror swap for each active Source's Mirror and sweep
      // the shared stale temp. An fs fault is contained, never a Layer-build
      // defect.
      yield* Effect.sync(() => {
        try {
          for (const s of registry.currentSources().filter((src) => src.active)) {
            recoverMirror(targets.mirrorRoot(s.id));
          }
          sweepStaleTmp(targets.kitTmpRoot());
        } catch (err) {
          log().warn({ module: "kit", err: String(err) }, "kit startup maintenance failed");
        }
      });
      return svc;
    }),
  );
}
