# C2 — Containers

Inside the Hive system boundary: processes (Shell, UI, Daemon) and the on-disk stores under `~/.hive/` and the bundled `bundled/` tree.

```mermaid
C4Container
    title Containers — Hive

    Person(user, "User")

    System_Boundary(hive, "Hive") {
        Container(shell, "Shell", "Electron main process", "Owns the window, tray, single-instance lock, deep links, auto-update. Spawns the Daemon as a child process. Code: shell/src/main.ts, preload.ts.")

        Container(ui, "UI", "React + Vite (TypeScript)", "Renders inside the Shell window (or a browser tab in dev). Pages for Agents, Capabilities, Chat, Settings. Talks to the Daemon over HTTP + SSE. Code: ui/src/.")

        Container(daemon, "Daemon", "Bun + Hono (TypeScript)", "The long-running process. Hosts the Agent Catalog, Runs, Capability Registry, Audit Log, Threads, Secrets, Config. HTTP + WS on localhost. Same binary serves Shell, browser tabs, CLI, headless servers. Code: src/server/.")

        ContainerDb(hivedb, "hive.db", "SQLite (WAL)", "Hot conversation state — Threads, Messages, Runs. ~/.hive/hive.db. ADR-0002.")

        ContainerDb(auditdb, "audit.db", "SQLite (WAL)", "Append-only Audit Log. Separate file from hive.db because write patterns and retention differ. ~/.hive/audit.db. ADR-0004.")

        ContainerDb(configyaml, "config.yaml", "YAML", "Deployment-wide Configuration. Hot-reloaded with reactive watchers. ~/.hive/config.yaml. ADR-0006.")

        ContainerDb(secretsdir, "secrets/", "Files (chmod 600)", "Secrets store — API keys, OAuth tokens. References, never inlined in audit. ~/.hive/secrets/. ADR-0008.")

        ContainerDb(tracelog, "daemon.log", "JSONL (Pino)", "Trace Log — diagnostic stream. Distinct from Audit. ~/.hive/logs/daemon.log.")

        ContainerDb(capdir, "Capability Manifests", "Filesystem", "Capability Registry source. Two-tier: bundled/{personal,workplace/<id>}/ (immutable, ships with Hive) and ~/.hive/capabilities/ (mutable, per install). ADR-0007.")

        ContainerDb(catalogdir, "Agent Catalog", "Filesystem", "Agent Harnesses on disk. Same two-tier layout as Capabilities. ADR-0007.")
    }

    System_Ext(llm, "LLM Providers", "Anthropic, OpenAI, Gemini, ...")
    System_Ext(mcp, "MCP Servers", "Personal / Workplace")
    System_Ext(cli, "External Agent CLIs", "claude-code, codex, ...")
    System_Ext(shellos, "Local Shell / OS")

    Rel(user, shell, "Clicks; types", "OS window events")
    Rel(shell, ui, "Loads renderer; injects baseUrl + token", "preload.ts → window.__hive")
    Rel(shell, daemon, "Spawns; supervises", "child_process")
    Rel(ui, daemon, "Reads state; starts Runs; streams events", "HTTP + SSE on localhost")

    Rel(daemon, hivedb, "Reads / writes Threads, Messages, Runs", "Drizzle / bun:sqlite")
    Rel(daemon, auditdb, "Appends AuditEvents", "bun:sqlite")
    Rel(daemon, configyaml, "Reads + writes; watches for external edits", "fs + watcher")
    Rel(daemon, secretsdir, "Reads on demand; writes via Settings UI", "fs")
    Rel(daemon, tracelog, "Writes structured diagnostics", "Pino")
    Rel(daemon, capdir, "Scans at boot; hot-reloads on change", "loader + watcher")
    Rel(daemon, catalogdir, "Scans at boot; hot-reloads on change", "loader + watcher")

    Rel(daemon, llm, "Completion calls (native backend)", "HTTPS via ModelGateway")
    Rel(daemon, mcp, "Tool calls; resource reads", "MCP")
    Rel(daemon, cli, "Spawns subprocess; parses stream-json", "stdio (today: claude-cli adapter)")
    Rel(daemon, shellos, "Runs allowlisted commands", "subprocess via run_shell Tool")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Notes

- **Two SQLite files, on purpose.** `hive.db` is hot conversation state (threads, messages, runs) with mixed reads and updates. `audit.db` is append-only with WAL + future archive rotation. Per the comment at the top of [src/db/hive-db.ts](../../src/db/hive-db.ts), the patterns are different enough that sharing a connection would be wrong.
- **Two-tier storage** (`bundled/` vs `~/.hive/`) applies to both Capabilities and the Agent Catalog. The bundled tree ships with the package and is immutable at runtime; the runtime tree is mutable per install. See [ADR-0007](../adr/0007-capability-lifecycle-and-storage.md).
- **Audit vs Trace.** Two stores, two purposes. Audit answers "what did the user or an agent do?"; Trace answers "why didn't this work?" The Audit Log uses a subscribe pattern (modules emit, Audit consumes); the Trace Log is written at the call site via the [src/lib/log.ts](../../src/lib/log.ts) singleton. See [ADR-0004](../adr/0004-audit-log-design.md).
- **No separate "Memory" container yet.** Per-Agent Memory partitions are deferred — see the Librarian Memory Model in [CONTEXT.md](../../CONTEXT.md#L96). When they land, Memory becomes its own ContainerDb here.
- **UI is one container.** In dev it runs under Vite HMR served by a separate `bun run dev:ui`; in production it's a static bundle the Shell loads. Same React tree either way.
