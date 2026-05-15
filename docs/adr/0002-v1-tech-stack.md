# v1 Tech Stack — Electron Shell + Bun Daemon

## What this ADR records

Six commitments for the v1 implementation surface, plus the architectural shape they imply. Supersedes the Tauri shell commitment from ADR-0001 — Electron is the shell for v1.

1. **Runtime (daemon): Bun + TypeScript.** Built-in TS, SQLite, test runner; `bun --watch` restart in ~50 ms.
2. **Native shell: Electron.** Wraps the UI in a real desktop window with tray, native notifications, deep links (`hive://`), and auto-update. Daemon is spawned as a child process — same Bun daemon used in headless mode.
3. **Model abstraction: `@earendil-works/pi-ai`** behind a Hive-owned `ModelGateway` interface. Multi-provider from day one — Anthropic, OpenAI, Gemini, Mistral, Bedrock, Ollama, LM Studio, vLLM, gateways (OpenRouter, LiteLLM).
4. **MCP via `@modelcontextprotocol/sdk`** — official TS reference implementation, used as both client (Capability Registry talks to user-installed MCP servers) and server (Hive can expose its own capabilities).
5. **Storage: SQLite (`bun:sqlite`) + Drizzle ORM.** Per-Agent Memory partitions; Agent Catalog, Threads, Runs, and audit log all in one DB.
6. **HTTP / WS: Hono.** Typed routes, native Bun support, end-to-end types into the UI via `hc()` client.

## What this supersedes

ADR-0001 committed to Tauri + embedded daemon. **That commitment is withdrawn in favor of Electron + separate Bun daemon.** Reasons:

- **Agent-driven iteration speed.** Tauri's Rust inner loop is materially slower than TypeScript (compile-check seconds vs sub-second). The whole stack staying in TS/Node means Claude Code iterates against one language and one toolchain.
- **Industry reference.** 0 of 19 surveyed AI desktop apps from top-tier labs use Tauri. Electron dominates chat-style AI UIs (Claude Desktop, Cursor, Windsurf, LM Studio, Linear, Superhuman). The "industrial" path is mapped.
- **Webview fragmentation is real.** Tauri inherits WKWebView / WebView2 / WebKitGTK quirks. Electron ships its own Chromium — uniform rendering, uniform debugging, uniform DevTools.
- **OS integrations are first-class.** Tray, native notifications, deep links, auto-update, single-instance lock, start-at-login — all have decade-mature Electron stories. Tauri equivalents exist but are less battle-tested.
- **The "headless mode" property is preserved.** Daemon is a separate Bun process. Running just the daemon (no Electron) is supported — Electron is the *presentation shell*, not the runtime. Same binary serves CLI, server, and dev-tunnel deployments.

ADR-0001's *vocabulary commitments* (Agent, Agent Harness, Memory, Capability, Thread, Run, Agent Catalog, Root Agent + Agent Manager) stand unchanged. The architectural blockers list (sync, secrets, registry versioning, concurrent-Run writes, INDEX, harness template/instance) stands. The shape changes; the kernel doesn't.

## Architecture shape

```
┌──────────────────────────────────────────────────┐
│ Electron Shell (Node main process)               │
│   ├─ BrowserWindow → Vite + React UI             │
│   ├─ Tray, notifications, deep links             │
│   ├─ Auto-updater (electron-updater)             │
│   └─ Spawns daemon as child process              │
└─────────────────────┬────────────────────────────┘
                      │ HTTP + WebSocket
                      ▼
┌──────────────────────────────────────────────────┐
│ Hive Daemon — Bun + Hono on localhost:3117       │
│ (also runnable standalone for headless / CLI)    │
│                                                  │
│ ┌────────────────────────────────────────────┐   │
│ │ Routes: /agents /threads /runs /caps /ws   │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ Run Executor                               │   │
│ │   ├─ Tool-use loop                         │   │
│ │   └─ Stream multiplexer (→ WS)             │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ ModelGateway (Hive-owned interface)        │   │
│ │   └─ @earendil-works/pi-ai                 │   │
│ │       └─ first-party SDKs                  │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ Capability Registry                        │   │
│ │   ├─ Skills (markdown, on-demand)          │   │
│ │   ├─ Tools (native, manifest-defined)      │   │
│ │   └─ MCP Clients                           │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ Storage: SQLite (Drizzle ORM)              │   │
│ │   ├─ Agent Catalog                         │   │
│ │   ├─ per-Agent Memory partitions           │   │
│ │   ├─ Threads + Runs                        │   │
│ │   └─ Audit log                             │   │
│ └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

Two processes, two languages: Electron's main process is Node (because Electron requires Node); the daemon is Bun. They talk over `localhost:3117` HTTP/WS — the same surface the UI uses. No IPC bridge to maintain.

## Picks

| Concern | Choice | Why |
|---|---|---|
| Daemon runtime | Bun (latest stable) | Built-in TS, SQLite, test runner; one tool replaces five |
| HTTP / WS | Hono | Native Bun, typed end-to-end with `hc()` client |
| Database | `bun:sqlite` + Drizzle ORM | Built-in driver, typed queries, plain SQL migrations |
| Validation | Zod | At every external boundary (HTTP body, MCP responses, Capability manifests) |
| Logging | Pino | Structured JSON, single tail-able stream — agent-readable |
| Model abstraction | `@earendil-works/pi-ai` | 70+ providers + local runtimes; wraps first-party SDKs; battle-tested at OpenClaw scale |
| MCP | `@modelcontextprotocol/sdk` | Reference TS implementation, client + server |
| File watching | `Bun.fileWatcher` / chokidar | Hot-reload Skills + Harness on save |
| Test runner | `bun test` | Built-in, sub-second feedback |
| Lint + format | Biome | One binary, one config, fast |
| UI build | Vite | Instant HMR |
| UI framework | React | Largest agent training corpus |
| Desktop shell | Electron | Uniform Chromium across OS; mature tray / notifications / deep links / single-instance |
| Shell packaging | electron-builder | Standard packager — `.dmg`, `.msi`, `.AppImage` |
| Shell auto-update | electron-updater | Pairs with electron-builder; signed releases via GitHub Releases |
| Shell hardening | electron-hardener (1Password) | Lock down Node integration in renderer; published pattern |
| Shell hot-reload (dev) | electronmon | Restart main on save; renderer uses Vite HMR |

## The ModelGateway hedge

`@earendil-works/pi-ai` is a pre-1.0 library (v0.74.0) coupled to OpenClaw's design choices. Risk shape:

- Pre-1.0 versioning: minor bumps may break.
- Bus factor: single-org maintenance.
- Canonical type shape reflects OpenClaw's needs, not necessarily Hive's.
- Novel-feature surface area may lag first-party SDKs by days to weeks.

**Mitigation:** every Hive call to pi-ai goes through a Hive-owned `ModelGateway` interface (~50–100 lines). If pi-ai stops fitting — or if a new provider feature must ship the day it lands — the gateway is the swap point. No call site outside the gateway imports pi-ai directly.

## Capability-layer leakage policy

Per the model-agnostic analysis, leaks live at the Run-start adapter, not the Capability manifest:

- **Skills** travel cleanly; per-provider concern is cache breakpoint placement + context budget.
- **Tools** need per-provider schema concessions (JSON Schema dialects differ). Manifest declares canonical schema; ModelGateway down-converts at Run start.
- **MCP Servers** are protocol-neutral; tool exposure inherits Tool-level leaks.
- **Agent Harness** is structurally clean; thinking-effort and cache-control knobs surface via typed `providerHints` on the manifest.

## Inner loop (agent-driven iteration)

```
T1:  bun --watch src/server.ts             # daemon restart ~50 ms
T2:  cd ui && bun run dev                  # Vite HMR ~100 ms
T3:  bun test --watch                      # sub-second feedback
T4:  cd shell && electronmon .             # only when iterating on shell code
```

For most UI / daemon work, **the shell does not need to run** — open `http://localhost:5173` in any browser. Boot Electron (T4) only when iterating on tray / notifications / deep-link / packaging behavior. This keeps the inner loop sub-second; Electron's restart cost is paid only when you actually touch shell code.

Production: `bun run build` the UI, daemon serves the bundle on `:3117`, Electron loads `localhost:3117` and spawns the daemon as a child process. Headless deployment: run the daemon binary alone.

## Directory layout (committed)

```
hive/
├── src/                          # daemon (Bun)
│   ├── server.ts                 # Hono app entry
│   ├── routes/                   # /agents, /threads, /runs, /capabilities, /ws
│   ├── agents/                   # Agent identity + lifecycle
│   ├── harness/                  # AgentHarness loader, capability resolution
│   ├── runs/                     # Run loop, streaming
│   ├── threads/                  # Thread persistence, message history
│   ├── memory/                   # per-Agent partitions, INDEX
│   ├── capabilities/             # registry, Skills, Tools, MCP clients
│   ├── gateway/                  # ModelGateway interface + pi-ai adapter
│   ├── db/                       # Drizzle schemas + migrations
│   └── lib/                      # logger, errors, shared types
├── ui/                           # Vite + React (consumed by browser & Electron)
├── shell/                        # Electron shell (Node main process)
│   ├── main.ts                   # BrowserWindow, daemon spawn, IPC, tray
│   ├── preload.ts                # context-bridge (hardened, no Node in renderer)
│   ├── tray.ts                   # tray icon + menu
│   ├── updater.ts                # electron-updater wiring
│   └── deep-links.ts             # hive:// protocol handler
└── data/                         # gitignored (DB, agent partitions)
```

## What this defers

- Cloud / hosted sync. Local-first only; sync is user-driven.
- Mobile native shells. Web UI over tunnel covers v1 mobile.
- Replacement of pi-ai with own adapters. Triggered only by concrete ModelGateway friction.
- Migration off Electron (to Tauri or native). Reconsider only if Electron's bundle size or memory footprint becomes a blocking concern for the portability mission.

## Deferred decisions (open)

- **Memory format details** (events vs prose, tiering, INDEX shape, promotion rules). Storage layer absorbs either.
- **Capability manifest schema** — particularly the shape of `providerHints` for per-provider Tool concessions (Gemini schema subset, OpenAI strict mode, Anthropic cache_control placement).
- **Secrets / auth profiles** — pi-ai's `auth-profiles` exist; whether Hive adopts that surface or wraps it under a Hive-native Secrets primitive is open.
- **Per-Agent vs per-Run model selection policy.** Harness declares preferred + fallback; the resolution algorithm at Run start is unspecified.
- **Daemon process management from Electron.** Spawn on app start vs lazy spawn vs attach-to-existing (if daemon already running headlessly). Affects "headless mode + open the app" composition.

## Verification

This stack is correct if, from a fresh checkout, the kernel can run one corp scenario and one personal scenario end-to-end (per ADR-0001's stop rule), with the inner loop under 1 s per iteration. If either fails, the picks are wrong — fix here before further commitments.
