// Daemon entrypoint and createServer() factory.
//
// createServer(opts) returns a Hono app + module handles, suitable for
// both production boot (Bun.serve picks up app.fetch) and tests
// (app.fetch(req) with no listener).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Hono } from "hono";
import { createAudit, type Audit } from "../audit/index.ts";
import { wireSubscriptions } from "../audit/subscriptions.ts";
import { createRegistry, type Registry } from "../capabilities/index.ts";
import { createCatalog, type Catalog } from "../catalog/index.ts";
import {
  type AppConfig,
  APP_CONFIG_DEFAULTS,
  AppConfigSchema,
  type Config,
  createConfig,
} from "../config/index.ts";
import { createLogger, setLogger } from "../lib/log.ts";
import { files, runtimeRoot } from "../lib/paths.ts";
import { createGateway, type ModelGateway } from "../model-gateway/index.ts";
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

  const config: Config<AppConfig> & { dispose(): void } =
    opts.mode === "memory"
      ? createConfig({
          mode: "memory",
          initial: APP_CONFIG_DEFAULTS,
          schema: AppConfigSchema,
        })
      : createConfig({
          mode: "file",
          path: files.config(),
          defaults: APP_CONFIG_DEFAULTS,
          schema: AppConfigSchema,
        });

  const registry = createRegistry({ watch: opts.mode === "file" });
  const catalog = createCatalog();
  const gateway = createGateway();

  const dispose = wireSubscriptions<AppConfig>(audit, {
    config,
    gateway,
    registry,
    catalog,
  });

  await registry.start();
  await catalog.start();

  const token = opts.token ?? (opts.mode === "memory" ? "test-token" : ensureToken());
  const port = opts.port ?? config.get("daemon").httpPort;

  const app = buildRoutes({ registry, catalog, audit, token });

  return {
    app,
    audit,
    config,
    registry,
    catalog,
    gateway,
    token,
    port,
    async dispose() {
      dispose();
      registry.dispose();
      catalog.dispose();
      config.dispose();
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
