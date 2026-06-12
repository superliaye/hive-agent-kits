// Daemon entrypoint and createServer() factory.
//
// createServer(opts) returns a Hono app + module handles, suitable for
// both production boot (Bun.serve picks up app.fetch) and tests
// (app.fetch(req) with no listener).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { Hono } from "hono";
import {
  AgentModelPrefsLive,
  type AgentModelPrefsSvc,
  AgentModelPrefs as AgentModelPrefsTag,
} from "../agent-prefs/index.ts";
import { AuditLive, Audit as AuditTag } from "../audit/effect/audit-live.ts";
import type { Audit } from "../audit/index.ts";
import { wireSubscriptions } from "../audit/subscriptions.ts";
import {
  BackendProbeLive,
  type BackendProbeSvc,
  BackendProbe as BackendProbeTag,
  notInstalledRunner,
} from "../backend-probe/index.ts";
import {
  BindingResolver,
  BindingResolverLive,
  createRegistry,
  type Registry,
} from "../capabilities/index.ts";
import { CatalogLive, Catalog as CatalogTag } from "../catalog/effect/catalog-live.ts";
import type { Catalog } from "../catalog/index.ts";
import { ConfigLive, Config as ConfigTag } from "../config/effect/config-live.ts";
import {
  APP_CONFIG_DEFAULTS,
  type AppConfig,
  AppConfigSchema,
  type Config,
} from "../config/index.ts";
import { HiveDb, HiveDbLive } from "../db/effect/hive-db-live.ts";
import { createLogger, log, setLogger } from "../lib/log.ts";
import { files, runtimeRoot } from "../lib/paths.ts";
import { createPiAiAdapter } from "../model-gateway/adapters/pi-ai.ts";
import { createGateway, type ModelGateway } from "../model-gateway/index.ts";
import {
  createRunExecutor,
  createRunsStore,
  type RunExecutor,
  type RunnableCatalogPort,
  runnableCatalog,
  type SkillProjectionPort,
  type SkillResolverPort,
} from "../runs/index.ts";
import { SecretsLive, Secrets as SecretsTag } from "../secrets/effect/secrets-live.ts";
import type { Secrets } from "../secrets/index.ts";
import { autoArchiveSweep } from "../threads/auto-archive.ts";
import { ThreadsLive, Threads as ThreadsTag } from "../threads/effect/threads-live.ts";
import type { Threads } from "../threads/index.ts";
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
  registry: Registry;
  catalog: Catalog;
  gateway: ModelGateway;
  secrets: Secrets;
  agentModelPrefs: AgentModelPrefsSvc;
  threads: Threads;
  runs: RunExecutor;
  backendProbe: BackendProbeSvc;
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

  // The six migrated modules compose into ONE root Layer owned by a single
  // ManagedRuntime (ADR-0011). The `mode`-driven adapter choice stays here at
  // the composition root, feeding each Live constructor — root configuration,
  // not a leaked requirement. Threads is built over the SAME `dataLayer` value
  // (HiveDb), which stays exposed for the unmigrated Runs path; binding it once
  // means ManagedRuntime memoizes ONE hive.db connection shared by both.
  const dbPath = opts.mode === "memory" ? ":memory:" : files.hiveDb();
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
  const agentPrefsOpts =
    opts.mode === "memory"
      ? ({ mode: "memory" } as const)
      : ({ mode: "file", path: files.agentModelPrefs() } as const);
  // Audit keeps its OWN sqlite file (~/.hive/audit.db); never routed onto hive.db.
  const auditOpts =
    opts.mode === "memory"
      ? ({ mode: "memory" } as const)
      : ({ mode: "file", path: files.auditDb() } as const);

  // Built ahead of the layer build so `BindingResolverLive(registry)` can fold
  // into `rootLayer` and be discharged off the single composition-root runtime
  // (no separate throwaway ManagedRuntime for skill resolution).
  const registry = createRegistry({ watch: opts.mode === "file" });

  const dataLayer = HiveDbLive(dbPath);
  const rootLayer = Layer.mergeAll(
    dataLayer,
    SecretsLive(secretsOpts),
    AgentModelPrefsLive(agentPrefsOpts),
    ConfigLive(configOpts),
    CatalogLive(),
    AuditLive(auditOpts),
    ThreadsLive().pipe(Layer.provide(dataLayer)),
    // Memory mode (tests/fast-iter) reports every backend as not installed so
    // booting a server never spawns `claude`/`codex`. File mode uses the real
    // Bun.spawn runner (the module default).
    BackendProbeLive(opts.mode === "memory" ? { runner: notInstalledRunner } : {}),
    // F2 binding resolver over the in-memory Registry — one composition-root
    // runtime owns it (P-3), not a second ManagedRuntime.
    BindingResolverLive(registry),
  );
  const runtime = ManagedRuntime.make(rootLayer);

  // The Live acquires are all synchronous, so `runSync` resolves the cached
  // service instances off the one runtime — the same live objects (including
  // their `.events` emitters) every consumer below shares.
  const hiveDb = runtime.runSync(HiveDb);
  const config: Config<AppConfig> = runtime.runSync(ConfigTag);
  const catalogSvc = runtime.runSync(CatalogTag);
  // Project to the legacy `Catalog` shape with a no-op `dispose` — `runtime.dispose()`
  // owns catalog teardown now, same pattern as the Secrets projection below.
  // (Otherwise the handle keeps a live `dispose()`: an independent teardown the
  // single root runtime should own.)
  const catalog: Catalog = { ...catalogSvc, dispose: () => {} };
  const secretsSvc = runtime.runSync(SecretsTag);
  // The resolved SecretsSvc is the legacy `Secrets` surface minus `dispose()`
  // (the runtime owns teardown now). Project the legacy shape so the routes +
  // handles type unchanged, with a no-op `dispose` (runtime.dispose() is the
  // real teardown).
  const secrets: Secrets = {
    events: secretsSvc.events,
    getAuth: (provider) => secretsSvc.getAuth(provider),
    setApiKey: (provider, apiKey) => secretsSvc.setApiKey(provider, apiKey),
    startOAuthLogin: (provider, callbacks) => secretsSvc.startOAuthLogin(provider, callbacks),
    remove: (provider) => secretsSvc.remove(provider),
    list: () => secretsSvc.list(),
    status: (provider) => secretsSvc.status(provider),
    dispose: () => {},
  };
  const agentModelPrefs: AgentModelPrefsSvc = runtime.runSync(AgentModelPrefsTag);
  const backendProbe: BackendProbeSvc = runtime.runSync(BackendProbeTag);
  // AuditSvc is exactly the legacy `Audit` surface (attach/query/subscriptions);
  // the DB handle is closed by the layer's release, not exposed on the value.
  const audit: Audit = runtime.runSync(AuditTag);

  const gateway = createGateway();
  // Threads + Runs consume the single Layer-owned `hive.db` handle. Threads
  // resolves off the root runtime (built over `dataLayer`); Runs still wraps the
  // raw `hiveDb` handle (unmigrated). Same connection, no second handle.
  const threads = runtime.runSync(ThreadsTag);
  const runsStore = createRunsStore(hiveDb);
  // Boot-time stale-Run recovery: any Run still `running` from a previous
  // process is flipped to `failed(daemon_restart)`. Per ADR for Part 3.
  runsStore.markStaleAsFailed();
  // Boot-time auto-archive sweep: threads idle past the idle window are
  // archived (system-initiated → trace, never audit).
  await autoArchiveSweep(threads);

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

  // Register the default multi-provider adapter (ADR-0002 §"Model abstraction":
  // pi-ai is the v1 default for anthropic/openai/google/mistral/bedrock/…).
  // Tests that want to override a provider can `registerAdapter(makeFakeAdapter([provider], …))`
  // — last registration wins per registry.test.ts.
  gateway.registerAdapter(createPiAiAdapter());

  // SkillResolverPort adapter (D-5): adapt the F2 BindingResolver over the
  // existing Capability Registry to the runs-owned port. F2's `resolveSkills`
  // is a synchronous, never-failing Effect, so we discharge it with runSync at
  // this composition root — runs/ never imports capabilities concretes. Skill
  // loads are scoped to the Run's bound names (load(boundNames, name)).
  // The resolver is reached only through the single composition-root runtime
  // (P-3) — `BindingResolverLive(registry)` is folded into `rootLayer` above.
  const bindingResolver = runtime.runSync(BindingResolver);
  const skillResolver: SkillResolverPort = {
    list: (boundNames) =>
      Effect.runSync(bindingResolver.resolveSkills(boundNames)).resolved.map((s) => ({
        name: s.name,
        description: s.description,
      })),
    load: (boundNames, name) => {
      if (!boundNames.includes(name)) return undefined;
      const found = Effect.runSync(bindingResolver.resolveSkills([name])).resolved[0];
      return found ? { description: found.description, body: found.body } : undefined;
    },
  };

  // SkillProjectionPort adapter (C3): the sibling port the CLI (claude-code)
  // path uses to copy bound skills into a `--add-dir` location. Reuses the same
  // `bindingResolver` handle + Effect.runSync discharge as skillResolver above —
  // no second runtime. Surfaces `path`/`origin` (the file-system facts the
  // projector needs), unlike the N3-shaped skillResolver.
  const skillProjection: SkillProjectionPort = {
    resolve: (names) =>
      Effect.runSync(bindingResolver.resolveSkills(names)).resolved.map((s) => ({
        name: s.name,
        path: s.path,
        origin: s.origin,
      })),
  };

  // RunnableCatalogPort adapter (E3/E5): the credentialed ∩ routable models the
  // symbolic-default resolver consumes, assembled by the SINGLE shared
  // `runnableCatalog` helper (P2) — the same globally-ordered list the title-gen
  // path and `GET /api/models` consume. Built ONCE here and threaded into BOTH
  // the executor and the routes (RoutesDeps.runnableCatalog). Snapshot per
  // Run/request — a newly-added credential is visible next time. pi-ai stays
  // imported only in its adapter (ADR-0005): enumeration goes through the
  // gateway seam.
  const runnableCatalogPort: RunnableCatalogPort = {
    snapshot: () => runnableCatalog(secrets, gateway),
  };

  const runs = createRunExecutor({
    threads,
    runs: runsStore,
    catalog,
    gateway,
    secrets,
    prefs: agentModelPrefs,
    runnableCatalog: runnableCatalogPort,
    skillResolver,
    skillProjection,
    // Cap port — snapshot of runs.maxIterations off the root Config (0 =
    // unlimited). Narrow consumer-owned port, not the whole Config tree.
    capConfig: { maxIterations: () => config.get("runs").maxIterations },
  });

  const dispose = wireSubscriptions<AppConfig>(audit, {
    config,
    gateway,
    registry,
    catalog,
    secrets,
    agentPrefs: agentModelPrefs,
    threads,
    runs,
    // Dedicated `permission` audit source (Q4) — the executor's separate
    // permission emitter, distinct from its `events` (run source).
    permission: { events: runs.permissionEvents },
    // Dedicated `backend` audit source — the executor's CLI-spawn emitter.
    backend: { events: runs.backendEvents },
    // Same `backend` source, second emitter — the user-triggered delegated
    // CLI-update action (BackendProbe service).
    backendUpdate: { events: backendProbe.events },
  });

  await registry.start();
  await catalog.start();

  const token = opts.token ?? (opts.mode === "memory" ? "test-token" : ensureToken());
  const port = opts.port ?? config.get("daemon").httpPort;

  const app = buildRoutes({
    registry,
    catalog,
    audit,
    threads,
    runs,
    secrets,
    gateway,
    agentModelPrefs,
    backendProbe,
    config,
    token,
    runnableCatalog: runnableCatalogPort,
  });

  return {
    app,
    audit,
    config,
    registry,
    catalog,
    gateway,
    secrets,
    agentModelPrefs,
    threads,
    runs,
    backendProbe,
    token,
    port,
    async dispose() {
      dispose();
      registry.dispose();
      // ONE teardown: releases Config (watcher + ref scope), Secrets (no-op),
      // Catalog (file watchers), Audit ($client.close), and HiveDb
      // ($client.close) — each exactly once via Layer memoization. This also
      // closes the previously-leaked hive.db and audit.db handles.
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
