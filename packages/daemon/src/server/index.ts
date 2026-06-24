// Daemon entrypoint and createServer() factory.
//
// createServer(opts) returns a Hono app + module handles, suitable for
// both production boot (Bun.serve picks up app.fetch) and tests
// (app.fetch(req) with no listener).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import type { Hono } from "hono";
import { AuditLive, Audit as AuditTag } from "../audit/effect/audit-live.ts";
import type { Audit } from "../audit/index.ts";
import { wireSubscriptions } from "../audit/subscriptions.ts";
import {
  BackendProbeLive,
  type BackendProbeSvc,
  BackendProbe as BackendProbeTag,
  BackendUpdaterLive,
  type BackendUpdaterSvc,
  BackendUpdater as BackendUpdaterTag,
  notInstalledRunner,
} from "../backend-probe/index.ts";
import {
  BackendReadinessLive,
  type BackendReadinessSvc,
  BackendReadinessService as BackendReadinessTag,
} from "../backend-readiness/index.ts";
import { ConfigLive, Config as ConfigTag } from "../config/effect/config-live.ts";
import {
  APP_CONFIG_DEFAULTS,
  type AppConfig,
  AppConfigSchema,
  type Config,
} from "../config/index.ts";
import { Kit, KitLive, type KitSvc } from "../kit/index.ts";
import { buildKitRoutes, type RunKit } from "../kit/routes.ts";
import { productionFetch } from "../kit/sync.ts";
import { createLogger, log, setLogger } from "../lib/log.ts";
import { files, runtimeRoot } from "../lib/paths.ts";
import { SecretsLive, Secrets as SecretsTag } from "../secrets/effect/secrets-live.ts";
import type { Secrets } from "../secrets/index.ts";
import {
  SourceRegistryLive,
  type SourceRegistrySvc,
  SourceRegistry as SourceRegistryTag,
} from "../sources/effect/sources-live.ts";
import { buildSourcesRoutes, type RunSources } from "../sources/routes.ts";
import { buildRoutes } from "./routes.ts";

export type ServerMode = "file" | "memory";

export type CreateServerOptions = {
  // "memory" — no persistence, used by tests and dev fast-iter.
  // "file"   — production: audit.db on disk, config.yaml hot-reload.
  mode: ServerMode;
  // Override the bearer token (tests). Default: ensure file under runtime/.token.
  token?: string;
  // Override the HTTP port. When set, takes precedence over Config's
  // `daemon.httpPort` — used by e2e tests for isolation. Bypasses Config so
  // a stale config.yaml value cannot fight the explicit choice.
  port?: number;
};

export type ServerHandles = {
  app: Hono;
  audit: Audit;
  config: Config<AppConfig>;
  secrets: Secrets;
  backendProbe: BackendProbeSvc;
  kit: KitSvc;
  token: string;
  port: number;
  dispose(): Promise<void>;
};

export async function createServer(opts: CreateServerOptions): Promise<ServerHandles> {
  if (opts.mode === "file") {
    // First-launch: ensure the runtime root exists before audit/config touch it.
    mkdirSync(runtimeRoot(), { recursive: true });
  }
  // Install the trace logger before any other module emits a log line.
  setLogger(createLogger({ mode: opts.mode === "memory" ? "silent" : "file" }));

  // The surviving modules compose into ONE root Layer owned by a single
  // ManagedRuntime (ADR-0011). The `mode`-driven adapter choice stays here at
  // the composition root, feeding each Live constructor — root configuration,
  // not a leaked requirement.
  const configOpts =
    opts.mode === "memory"
      ? ({ mode: "memory", initial: APP_CONFIG_DEFAULTS, schema: AppConfigSchema } as const)
      : ({
          mode: "file",
          path: files.config(),
          defaults: APP_CONFIG_DEFAULTS,
          schema: AppConfigSchema,
        } as const);
  const secretsOpts =
    opts.mode === "memory"
      ? ({ mode: "memory" } as const)
      : ({ mode: "file", path: files.secrets() } as const);
  const sourcesOpts =
    opts.mode === "memory"
      ? ({ mode: "memory" } as const)
      : ({ mode: "file", path: files.sources() } as const);
  // Audit keeps its OWN sqlite file (~/.hive/audit.db).
  const auditOpts =
    opts.mode === "memory"
      ? ({ mode: "memory" } as const)
      : ({ mode: "file", path: files.auditDb() } as const);

  // Memory mode (tests/fast-iter) reports every backend as not installed so
  // booting a server never spawns `claude`/`codex`. File mode uses the real
  // Bun.spawn runner (the module default). The probe and the sibling updater
  // (OQ-5) share the SAME runner option so a memory-mode probe and updater agree.
  const backendRunnerOpts = opts.mode === "memory" ? ({ runner: notInstalledRunner } as const) : {};
  const backendProbeLayer = BackendProbeLive(backendRunnerOpts);
  const rootLayer = Layer.mergeAll(
    SecretsLive(secretsOpts),
    ConfigLive(configOpts),
    AuditLive(auditOpts),
    backendProbeLayer,
    // The delegated-update verb lives on this sibling service (OQ-5), depending
    // on `BackendProbe` for the re-probe. Provide the probe layer so the
    // dependency is discharged at the module boundary, not leaked to the root.
    BackendUpdaterLive(backendRunnerOpts).pipe(Layer.provide(backendProbeLayer)),
    // Kit module (capability deploy-manager). Provides its own deploy-target
    // port + exec adapter; the production HTTP fetch is the only edge injected.
    KitLive({ fetch: productionFetch() }),
    // Sources registry (ADR-0023). Hive-private JSON store; memory mode in
    // tests/dev writes no real ~/.hive/sources.json.
    SourceRegistryLive(sourcesOpts),
  );
  const runtime = ManagedRuntime.make(rootLayer);

  // The Live acquires are all synchronous, so `runSync` resolves the cached
  // service instances off the one runtime — the same live objects (including
  // their `.events` emitters) every consumer below shares.
  const config: Config<AppConfig> = runtime.runSync(ConfigTag);
  const secretsSvc = runtime.runSync(SecretsTag);
  // The resolved SecretsSvc is the legacy `Secrets` surface minus `dispose()`
  // (the runtime owns teardown now). Project the legacy shape so the routes +
  // handles type unchanged, with a no-op `dispose` (runtime.dispose() is the
  // real teardown).
  const secrets: Secrets = {
    events: secretsSvc.events,
    getAuth: (provider) => secretsSvc.getAuth(provider),
    setApiKey: (provider, apiKey) => secretsSvc.setApiKey(provider, apiKey),
    remove: (provider) => secretsSvc.remove(provider),
    list: () => secretsSvc.list(),
    status: (provider) => secretsSvc.status(provider),
    dispose: () => {},
  };
  const backendProbe: BackendProbeSvc = runtime.runSync(BackendProbeTag);
  const backendUpdater: BackendUpdaterSvc = runtime.runSync(BackendUpdaterTag);
  // AuditSvc is exactly the legacy `Audit` surface (attach/query/subscriptions);
  // the DB handle is closed by the layer's release, not exposed on the value.
  const audit: Audit = runtime.runSync(AuditTag);

  // Kit module (capability deploy-manager). Resolved off the single root runtime
  // like every other live service. `runKit` discharges a Kit Effect to a
  // Promise<Either>-like for the routes — never throwing the typed error out.
  const kit: KitSvc = runtime.runSync(Kit);
  // Sources registry — resolved off the same root runtime.
  const sourceRegistry: SourceRegistrySvc = runtime.runSync(SourceRegistryTag);
  const runKit: RunKit = <A, E>(effect: Effect.Effect<A, E>) =>
    runtime.runPromiseExit(effect).then((exit) =>
      Exit.match(exit, {
        onSuccess: (value): { ok: true; value: A } | { ok: false; error: E } => ({
          ok: true,
          value,
        }),
        // A typed `Fail` cause squashes to its `E` value; a defect would surface
        // as the thrown value, which the routes treat as a 500.
        onFailure: (cause): { ok: true; value: A } | { ok: false; error: E } => ({
          ok: false,
          error: Cause.squash(cause) as E,
        }),
      }),
    );

  // Boot-time backend availability probe (doctor-style; ADR-0016 detect-not-
  // manage). A system diagnostic → trace, never audit. Fire-and-forget so a
  // missing or slow CLI never delays daemon readiness; the service trace-logs
  // any unhealthy backend on its own.
  backendProbe
    .probeAll()
    .then((statuses) => {
      log().info(
        {
          module: "backend-probe",
          backends: statuses.map((s) => ({
            backend: s.backend,
            reason: s.reason,
            version: s.version,
          })),
        },
        "backend availability probed",
      );
    })
    .catch((err) => {
      log().error({ module: "backend-probe", err }, "backend availability probe failed");
    });

  // Backend Readiness projection: the per-backend health ∩ provider-auth join
  // feeding the Settings "Backends" page. Its deps are adapted HERE onto the
  // module's narrow consumer-owned ports — the resolved BackendProbe (probeAll)
  // and Secrets (list) — so the module Layer carries no probe/secrets
  // requirement. Resolved off the root runtime like every other live service.
  const backendReadiness: BackendReadinessSvc = runtime.runSync(
    BackendReadinessTag.pipe(
      Effect.provide(
        BackendReadinessLive({
          probe: { probeAll: () => backendProbe.probeAll() },
          // `list()` is typed `"ok" | "expired" | "missing"` but never emits
          // "missing" (that status is only for a single-provider lookup of an
          // absent entry). Narrow to the two statuses the readiness port consumes;
          // the filter excludes the impossible value provably at the seam.
          secrets: {
            list: () =>
              secrets
                .list()
                .filter(
                  (p): p is typeof p & { status: "ok" | "expired" } => p.status !== "missing",
                ),
          },
        }),
      ),
    ),
  );

  const port = opts.port ?? config.get("daemon").httpPort;

  const dispose = wireSubscriptions<AppConfig>(audit, {
    config,
    secrets,
    // Same `backend` source — the user-triggered delegated CLI-update action
    // (the sibling BackendUpdater service, OQ-5).
    backendUpdate: { events: backendUpdater.events },
    // Dedicated `deploy` source — a Kit deploy is a user action (refs-only).
    deploy: { events: kit.events },
    // Dedicated `sources` source — a Source registry mutation is a user action (refs-only).
    sourceRegistry: { events: sourceRegistry.events },
  });

  const token = opts.token ?? (opts.mode === "memory" ? "test-token" : ensureToken());

  const app = buildRoutes({
    audit,
    secrets,
    backendProbe,
    backendReadiness,
    backendUpdater,
    config,
    token,
  });

  // Kit deploy-manager routes, mounted additively behind the surviving server.
  app.route("/", buildKitRoutes(kit, runKit));

  // Sources registry routes (ADR-0023). Reuse the same Effect-discharge runner.
  const runSources: RunSources = runKit;
  app.route("/", buildSourcesRoutes(sourceRegistry, runSources));

  // Auto fetch-on-launch: a NON-BLOCKING sync-check. A failure is traced + folds
  // into the typed sync status (check_failed/rate_limited), never fatal and never
  // reported as "up to date".
  runKit(kit.sync())
    .then((res) => {
      if (res.ok) {
        log().info({ module: "kit", status: res.value.status }, "kit launch sync-check complete");
      } else {
        log().warn(
          { module: "kit", reason: (res.error as { reason?: string }).reason },
          "kit launch sync-check failed (non-fatal)",
        );
      }
    })
    .catch((err) => {
      log().error({ module: "kit", err: String(err) }, "kit launch sync-check threw");
    });

  return {
    app,
    audit,
    config,
    secrets,
    backendProbe,
    kit,
    token,
    port,
    async dispose() {
      dispose();
      // ONE teardown: releases Config (watcher + ref scope), Secrets (no-op),
      // Audit ($client.close), and the backend modules — each exactly once via
      // Layer memoization.
      await runtime.dispose();
    },
  };
}

// Read or generate the runtime bearer token at <runtime>/.token.
// chmod 0600 on Unix; Windows ignores the bits but the file is per-user
// inside the user's home dir.
function ensureToken(): string {
  const path = files.token();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = crypto.randomUUID();
  writeFileSync(path, token, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on Windows.
  }
  return token;
}
