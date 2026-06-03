// Daemon entrypoint and createServer() factory.
//
// createServer(opts) returns a Hono app + module handles, suitable for
// both production boot (Bun.serve picks up app.fetch) and tests
// (app.fetch(req) with no listener).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import type { Hono } from "hono";
import { type Audit, createAudit } from "../audit/index.ts";
import { wireSubscriptions } from "../audit/subscriptions.ts";
import { type Registry, createRegistry } from "../capabilities/index.ts";
import { Catalog as CatalogTag, CatalogLive } from "../catalog/effect/catalog-live.ts";
import type { Catalog } from "../catalog/index.ts";
import { Config as ConfigTag, ConfigLive } from "../config/effect/config-live.ts";
import { APP_CONFIG_DEFAULTS, type AppConfig, AppConfigSchema, type Config } from "../config/index.ts";
import { HiveDb, HiveDbLive } from "../db/effect/hive-db-live.ts";
import { createLogger, setLogger } from "../lib/log.ts";
import { files, runtimeRoot } from "../lib/paths.ts";
import { createPiAiAdapter } from "../model-gateway/adapters/pi-ai.ts";
import { type ModelGateway, createGateway } from "../model-gateway/index.ts";
import { type RunExecutor, createRunExecutor, createRunsStore } from "../runs/index.ts";
import { Secrets as SecretsTag, SecretsLive } from "../secrets/effect/secrets-live.ts";
import type { Secrets } from "../secrets/index.ts";
import { type Threads, createThreads } from "../threads/index.ts";
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
  threads: Threads;
  runs: RunExecutor;
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
  const audit =
    opts.mode === "memory"
      ? createAudit({ mode: "memory" })
      : createAudit({ mode: "file", path: files.auditDb() });

  // The four migrated modules compose into ONE root Layer owned by a single
  // ManagedRuntime (ADR-0011). The `mode`-driven adapter choice stays here at
  // the composition root, feeding each Live constructor — root configuration,
  // not a leaked requirement.
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

  const rootLayer = Layer.mergeAll(
    HiveDbLive(dbPath),
    SecretsLive(secretsOpts),
    ConfigLive(configOpts),
    CatalogLive(),
  );
  const runtime = ManagedRuntime.make(rootLayer);

  // The Live acquires are all synchronous, so `runSync` resolves the cached
  // service instances off the one runtime — the same live objects (including
  // their `.events` emitters) every consumer below shares.
  const hiveDb = runtime.runSync(HiveDb);
  const config: Config<AppConfig> = runtime.runSync(ConfigTag);
  const catalog: Catalog = runtime.runSync(CatalogTag);
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

  const registry = createRegistry({ watch: opts.mode === "file" });
  const gateway = createGateway();
  // Threads + Runs consume the single Layer-owned `hive.db` handle (the
  // `"shared"` mode is exactly this). No second connection.
  const threads = createThreads({ mode: "shared", db: hiveDb });
  const runsStore = createRunsStore(hiveDb);
  // Boot-time stale-Run recovery: any Run still `running` from a previous
  // process is flipped to `failed(daemon_restart)`. Per ADR for Part 3.
  runsStore.markStaleAsFailed();

  // Register the default multi-provider adapter (ADR-0002 §"Model abstraction":
  // pi-ai is the v1 default for anthropic/openai/google/mistral/bedrock/…).
  // Tests that want to override a provider can `registerAdapter(makeFakeAdapter([provider], …))`
  // — last registration wins per registry.test.ts.
  gateway.registerAdapter(createPiAiAdapter());

  const runs = createRunExecutor({
    threads,
    runs: runsStore,
    catalog,
    gateway,
    secrets,
  });

  const dispose = wireSubscriptions<AppConfig>(audit, {
    config,
    gateway,
    registry,
    catalog,
    secrets,
    runs,
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
    config,
    token,
  });

  return {
    app,
    audit,
    config,
    registry,
    catalog,
    gateway,
    secrets,
    threads,
    runs,
    token,
    port,
    async dispose() {
      dispose();
      registry.dispose();
      // ONE teardown: releases Config (watcher + ref scope), Secrets (no-op),
      // Catalog (file watchers), and HiveDb ($client.close) — each exactly once
      // via Layer memoization. This also closes the previously-leaked hive.db
      // handle.
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
