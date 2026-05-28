# C3 — Daemon Components

Modules inside the Daemon container. Each one maps to a directory under [src/](../../src/). The wiring lives in [createServer()](../../src/server/index.ts) — read it alongside this diagram.

```mermaid
C4Component
    title Components — Daemon

    Container_Boundary(daemon, "Daemon") {
        Component(server, "Server", "Hono app", "HTTP + SSE routes, bearer auth, CORS. Boot wires every module via createServer(). src/server/.")

        Component(runs, "Runs", "Run executor + store", "Thread → Run → event-stream loop. Resolves agent → model + auth, calls gateway.complete(), accumulates assistant content, appends to Thread. Emits RunModuleEvents. src/runs/.")

        Component(gateway, "ModelGateway", "Adapter registry + complete()", "Single seam for LLM completion. Resolves 'provider/model' → adapter, returns AsyncIterable<GatewayEvent>. ADR-0005. src/model-gateway/.")

        Component(adapters, "Provider Adapters", "pi-ai, claude-cli, fake", "Per-provider translation to GatewayEvent. pi-ai for hosted providers; claude-cli spawns the local claude CLI; fake for tests. src/model-gateway/adapters/.")

        Component(catalog, "Agent Catalog", "Loader + in-memory index", "Reads Agent Harnesses from the two-tier store. Emits CatalogEvents (harness.updated). src/catalog/.")

        Component(registry, "Capability Registry", "Loader + in-memory index", "Reads Capability Manifests (Skills, Prompt Snippets, Tools, MCP Servers) from the two-tier store. ADR-0003, ADR-0007. src/capabilities/.")

        Component(threads, "Threads", "Store", "Persistent conversations. Read history; append user + assistant messages. src/threads/.")

        Component(secrets, "Secrets", "Store + OAuth", "API keys, OAuth tokens. Resolves provider → AuthInput for Runs. Emits SecretEvents — references only, never values. ADR-0008. src/secrets/.")

        Component(config, "Config", "Reactive YAML store", "Deployment-wide settings. config.watch(key, listener) for reactive subscribers. Emits ConfigEvents. ADR-0006. src/config/.")

        Component(audit, "Audit", "Subscriber + SQLite writer", "Subscribes to module event streams via subscriptions.ts and persists normalized AuditEvent rows. ADR-0004. src/audit/.")

        Component(tracelog, "Trace Logger", "Pino singleton", "Diagnostic JSONL stream. Imported by every module; written at the call site. src/lib/log.ts.")

        Component(hivedb, "hive.db opener", "bun:sqlite + Drizzle", "Single WAL-mode SQLite handle shared by Threads and Runs stores. src/db/hive-db.ts.")
    }

    Person(client, "UI / CLI / Shell", "HTTP + SSE clients")
    System_Ext(llm, "LLM Providers")
    System_Ext(cli, "claude CLI", "External binary")

    Rel(client, server, "REST + SSE", "HTTPS / WS")

    Rel(server, runs, "startRun, list, cancel")
    Rel(server, threads, "create, list, append")
    Rel(server, catalog, "list, get, patch bindings")
    Rel(server, registry, "list, get manifest")
    Rel(server, secrets, "set, list providers")
    Rel(server, config, "get, watch, set")
    Rel(server, audit, "query")

    Rel(runs, threads, "read history; append messages")
    Rel(runs, catalog, "resolve agent → harness")
    Rel(runs, gateway, "complete(input) → events")
    Rel(runs, secrets, "resolve provider → AuthInput")

    Rel(gateway, adapters, "dispatch to registered adapter")
    Rel(adapters, llm, "wire protocol", "HTTPS")
    Rel(adapters, cli, "spawn + parse stream-json", "stdio")

    Rel(threads, hivedb, "SQL")
    Rel(runs, hivedb, "SQL")

    Rel(audit, runs, "subscribe RunModuleEvents")
    Rel(audit, catalog, "subscribe CatalogEvents")
    Rel(audit, secrets, "subscribe SecretEvents")
    Rel(audit, config, "subscribe ConfigEvents")
    Rel(audit, registry, "subscribe (future: user-initiated adds)")
    Rel(audit, gateway, "subscribe (future: user-triggered)")

    Rel(runs, tracelog, "structured logs")
    Rel(catalog, tracelog, "structured logs")
    Rel(registry, tracelog, "structured logs")
    Rel(gateway, tracelog, "structured logs")
    Rel(server, tracelog, "structured logs")
```

## Notes

- **Server is the wiring root.** [createServer()](../../src/server/index.ts) constructs every module, injects dependencies, and calls [wireSubscriptions()](../../src/audit/subscriptions.ts) to hook Audit onto the others. The arrows out of Server in the diagram are HTTP routes; the arrows between non-Server components are direct in-process dependencies wired at boot.
- **Audit subscribes; nothing pushes.** Per [ADR-0004](../adr/0004-audit-log-design.md), there is no `audit.record(...)` API. Audit consumes typed event emitters from Runs, Catalog, Secrets, Config (and, in the future, Permission, MCP, Memory). The "subscribe" arrows go *from* Audit *to* the emitter.
- **Two SQLite files, two openers.** Threads + Runs share [hive.db](../../src/db/hive-db.ts). Audit has its own file under [src/audit/db.ts](../../src/audit/db.ts). Connection sharing was rejected on purpose — write patterns differ.
- **The claude CLI is currently a Provider Adapter, not an Agent Backend.** [src/model-gateway/adapters/claude-cli.ts](../../src/model-gateway/adapters/claude-cli.ts) spawns the `claude` binary as a model provider. The future CLI-driven Agent Backend described in [CONTEXT.md](../../CONTEXT.md#L113) would sit alongside Runs and bypass the gateway — when that lands, the diagram grows a second backend lane out of Runs.
- **Trace Logger is a singleton, not a service.** Every module imports `log()` from [src/lib/log.ts](../../src/lib/log.ts) and writes at the call site. The diagram shows a few representative arrows; in reality almost every module writes trace.
- **Missing modules.** Permission, MCP server lifecycle, and per-Agent Memory are documented in CONTEXT.md but not yet implemented under `src/`. They will appear here as they land.
