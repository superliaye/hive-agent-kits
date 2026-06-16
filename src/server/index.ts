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
  BackendUpdaterLive,
  type BackendUpdaterSvc,
  BackendUpdater as BackendUpdaterTag,
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
import { files, runtime as runtimePaths, runtimeRoot } from "../lib/paths.ts";
import type { BackendInvocation } from "../runs/backends/invocation.ts";
import { createDefaultSkillFsCopy, projectSkills } from "../runs/backends/skills.ts";
import {
  type AgentLifecyclePort,
  type BackendAdapters,
  type CapabilityInvokePort,
  createCapabilityMcpServer,
  createClaudeAdapter,
  createCodexAdapter,
  createRunExecutor,
  createRunsStore,
  type RunExecutor,
  type RunnableCatalogPort,
  runnableCatalog,
  type SkillProjectionPort,
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
  // TEST SEAM (memory mode): inject fake backend adapters so a route test can
  // drive a Run without spawning a real vendor SDK. Production builds the real
  // Claude/Codex adapters; this override replaces them when present.
  adapters?: BackendAdapters;
};

export type ServerHandles = {
  app: Hono;
  audit: Audit;
  config: Config<AppConfig>;
  registry: Registry;
  catalog: Catalog;
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
  // Memory mode (tests/fast-iter) reports every backend as not installed so
  // booting a server never spawns `claude`/`codex`. File mode uses the real
  // Bun.spawn runner (the module default). The probe and the sibling updater
  // (OQ-5) share the SAME runner option so a memory-mode probe and updater agree.
  const backendRunnerOpts = opts.mode === "memory" ? ({ runner: notInstalledRunner } as const) : {};
  const backendProbeLayer = BackendProbeLive(backendRunnerOpts);
  const rootLayer = Layer.mergeAll(
    dataLayer,
    SecretsLive(secretsOpts),
    AgentModelPrefsLive(agentPrefsOpts),
    ConfigLive(configOpts),
    CatalogLive(),
    AuditLive(auditOpts),
    ThreadsLive().pipe(Layer.provide(dataLayer)),
    backendProbeLayer,
    // The delegated-update verb lives on this sibling service (OQ-5), depending
    // on `BackendProbe` for the re-probe. Provide the probe layer so the
    // dependency is discharged at the module boundary, not leaked to the root.
    BackendUpdaterLive(backendRunnerOpts).pipe(Layer.provide(backendProbeLayer)),
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
  const backendUpdater: BackendUpdaterSvc = runtime.runSync(BackendUpdaterTag);
  // AuditSvc is exactly the legacy `Audit` surface (attach/query/subscriptions);
  // the DB handle is closed by the layer's release, not exposed on the value.
  const audit: Audit = runtime.runSync(AuditTag);

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

  // SkillProjectionPort adapter: adapt the F2 BindingResolver over the Capability
  // Registry to the runs-owned port. `resolveSkills` is a synchronous,
  // never-failing Effect, discharged with runSync at this composition root —
  // runs/ never imports capabilities concretes. Surfaces `path`/`origin` (the
  // file-system facts the per-Run skill projector needs). Reached only through
  // the single composition-root runtime (BindingResolverLive folded into
  // rootLayer above).
  const bindingResolver = runtime.runSync(BindingResolver);
  const skillProjection: SkillProjectionPort = {
    resolve: (names) =>
      Effect.runSync(bindingResolver.resolveSkills(names)).resolved.map((s) => ({
        name: s.name,
        path: s.path,
        origin: s.origin,
      })),
  };

  // RunnableCatalogPort adapter: the credentialed ∩ routable models the
  // symbolic-default resolver consumes, assembled by the SINGLE shared
  // `runnableCatalog` helper (the same globally-ordered list title-gen and
  // `GET /api/models` consume). The catalog SOURCE is now pi-ai's model registry
  // (Migration §3) — there is no ModelGateway. Snapshot per Run/request.
  const runnableCatalogPort: RunnableCatalogPort = {
    snapshot: () => runnableCatalog(secrets),
  };

  // The port is resolved here (before the executor) so the capability MCP
  // endpoint URL both backends connect to is known. Explicit override > Config.
  const port = opts.port ?? config.get("daemon").httpPort;
  const mcpEndpoint = `http://127.0.0.1:${port}/mcp`;

  // The ONE Hive capability MCP server (spec §unified MCP surface): Memory (stub),
  // capability invocation over the Registry, and the AM-lifecycle tools over the
  // Catalog. Served over THIS daemon (mounted on app.all("/mcp") below); both SDK
  // backends connect by `mcpEndpoint`.
  const capabilityInvoke: CapabilityInvokePort = {
    invoke: async (name, args) => {
      try {
        const found = registry.get("tool", name);
        if (!found) return { content: `unknown capability: ${name}`, isError: true };
        // Tool capabilities are registry entries; there is no in-process tool
        // runner yet (the native tools are deleted). Return a structured ack so
        // the seam is invocable end-to-end; a real tool runtime is a follow-up.
        return {
          content: JSON.stringify({ invoked: name, args, acknowledged: true }),
          isError: false,
        };
      } catch (err) {
        return { content: `capability invoke failed: ${String(err)}`, isError: true };
      }
    },
  };
  const agentLifecycle: AgentLifecyclePort = {
    createAgent: async (input) => {
      const created = await catalog.createAgent(input);
      return { agentId: created.agentId };
    },
    updateAgentHarness: async ({ agentId, bindings }) => {
      const updated = await catalog.updateBindings(agentId, bindings, "agent-manager");
      return { agentId: updated.agentId };
    },
    destroyAgent: async ({ agentId }) => {
      await catalog.destroyAgent(agentId);
    },
  };
  const capabilityMcp = createCapabilityMcpServer({
    capabilities: capabilityInvoke,
    agents: agentLifecycle,
  });

  // The two SDK backend adapters. Skill projection retargets per-Run: Claude
  // projects into an isolated plugins dir; Codex projects into the workspace
  // `.agents/skills`. The fs-copy edge + cleanup are shared.
  const skillFsCopy = createDefaultSkillFsCopy();
  const claudeAdapter = createClaudeAdapter({
    projectSkills: async (invocation: BackendInvocation) => {
      if (invocation.skills.length === 0) return undefined;
      const root = runtimePaths.backendPluginRoot(invocation.agentId, invocation.runId);
      const skillsDir = runtimePaths.backendPluginSkillsDir(invocation.agentId, invocation.runId);
      const landed = await projectSkills({
        skills: invocation.skills,
        skillsDir,
        copy: skillFsCopy.copy,
        runId: invocation.runId,
      });
      return landed ? root : undefined;
    },
    cleanupSkills: (invocation: BackendInvocation) => {
      if (invocation.skills.length === 0) return;
      const root = runtimePaths.backendPluginRoot(invocation.agentId, invocation.runId);
      skillFsCopy.remove(root).catch(() => {});
    },
  });
  const codexAdapter = createCodexAdapter({
    projectSkills: async (invocation: BackendInvocation) => {
      if (invocation.skills.length === 0) return;
      // Codex discloses skills from `.agents/skills` under its workspace cwd
      // (no out-of-tree option; the bound-to-a-repo case degrades — ADR-0019).
      const { join } = await import("node:path");
      await projectSkills({
        skills: invocation.skills,
        skillsDir: join(invocation.cwd, ".agents", "skills"),
        copy: skillFsCopy.copy,
        runId: invocation.runId,
      });
    },
  });

  const runs = createRunExecutor({
    threads,
    runs: runsStore,
    catalog,
    secrets,
    // Production wires the real SDK adapters; a memory-mode test may inject fakes.
    adapters: opts.adapters ?? { "claude-code": claudeAdapter, codex: codexAdapter },
    mcpEndpoint,
    prefs: agentModelPrefs,
    runnableCatalog: runnableCatalogPort,
    skillProjection,
  });

  const dispose = wireSubscriptions<AppConfig>(audit, {
    config,
    registry,
    catalog,
    secrets,
    agentPrefs: agentModelPrefs,
    threads,
    runs,
    // Dedicated `backend` audit source — the executor's SDK-backend run +
    // tool-observed emitter.
    backend: { events: runs.backendEvents },
    // Same `backend` source, second emitter — the user-triggered delegated
    // CLI-update action (the sibling BackendUpdater service, OQ-5).
    backendUpdate: { events: backendUpdater.events },
  });

  await registry.start();
  await catalog.start();

  const token = opts.token ?? (opts.mode === "memory" ? "test-token" : ensureToken());

  const app = buildRoutes({
    registry,
    catalog,
    audit,
    threads,
    runs,
    secrets,
    agentModelPrefs,
    backendProbe,
    backendUpdater,
    config,
    token,
    runnableCatalog: runnableCatalogPort,
  });

  // Mount the capability MCP server on the daemon (local HTTP). Both SDK
  // backends connect to `${mcpEndpoint}`. Auth-exempt: it is bound to 127.0.0.1
  // and consumed by the daemon's own child SDK processes.
  app.all("/mcp", (c) => capabilityMcp.handle(c.req.raw));

  return {
    app,
    audit,
    config,
    registry,
    catalog,
    secrets,
    agentModelPrefs,
    threads,
    runs,
    backendProbe,
    token,
    port,
    async dispose() {
      dispose();
      await capabilityMcp.dispose();
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
