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
│ │ Run module (Agent Backend seam)            │   │
│ │   ├─ native       (ModelGateway + tools)   │   │
│ │   ├─ claude-code  (spawn `claude`)         │   │
│ │   ├─ codex        (spawn `codex`)          │   │
│ │   └─ Stream multiplexer (→ WS)             │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ ModelGateway (used by native backend only) │   │
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
| Shell packaging | `@electron/packager` | Produces a runnable, unsigned app directory (`Hive.exe` + resources). No installer in v1 — see "Why not electron-builder" below |
| Shell auto-update | (deferred to v1.1) | Pairs with electron-builder + signing cert; not yet wired |
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

## User data location: unified `~/.hive/` across platforms

Hive stores all user-facing runtime data under a single directory: `~/.hive/` on every OS. Aligns with **OpenClaw** (`~/.openclaw/`) and **Hermes** (`~/.hermes/`); see CONTEXT.md → "Reference projects".

```
~/.hive/
├── .token                          # daemon auth token (chmod 0600 on Unix)
├── config.yaml                     # daemon config (audit retention, defaults)
├── hive.db                         # main SQLite: Agents, Threads, Runs, Memory, Registry
├── audit.db                        # audit SQLite (separate file per ADR-0004)
├── audit-archive/                  # rotated audit JSONL (when autoRotate enabled)
├── capabilities/
│   ├── skills/<name>/SKILL.md
│   ├── snippets/<name>/SNIPPET.md
│   └── harnesses/<agent-id>/HARNESS.md
├── agents/<agent-id>/
│   ├── auth-profiles.json          # OpenClaw-shaped secrets per agent (ADR-0003 G1)
│   └── memory.md                   # per-Agent memory (format deferred)
├── mcp/servers.json                # MCP server config
└── logs/daemon.log                 # Pino structured logs (separate from audit)
```

Rejected: OS-native paths via Electron's `app.getPath('userData')` (`%LOCALAPPDATA%\Hive\` / `~/Library/Application Support/Hive/` / `~/.local/share/Hive/`). Idiomatic per-OS but breaks the unified-path mental model and creates per-OS branching in every doc, every CLI message, and every sync tool. The cost of `~/.hive/` looking unusual on Windows is much lower than the cost of three different paths.

A single source-of-truth helper exposes every path:

```ts
// src/lib/paths.ts
import { homedir } from "os"
import { join } from "path"
export const HIVE_DIR  = join(homedir(), ".hive")
export const HIVE_DB   = join(HIVE_DIR, "hive.db")
export const AUDIT_DB  = join(HIVE_DIR, "audit.db")
// ... etc.
```

Every other module imports from here. No path strings hardcoded elsewhere.

**Portability partition** (relevant to ADR-0001 blocker #1, future sync ADR):

| Folder | Travels with user | Notes |
|---|---|---|
| `capabilities/{skills,snippets,harnesses}/` | Personal-origin yes; Workplace stays | Per-Capability origin tag |
| `agents/<id>/memory.md` | Yes (Personal-origin) | Per-Agent partition |
| `agents/<id>/auth-profiles.json` | Per-secret `copyToAgents` flag (OpenClaw shape) | OAuth refresh tokens don't travel by default |
| `mcp/servers.json` | Per-server origin | Personal servers travel; Workplace stay |
| `hive.db` | No | Operational state — deployment-local |
| `audit.db` | No | Per-deployment audit log |
| `logs/`, `.token` | No | Local-only |

## Daemon-from-Electron lifecycle

Goal: **the user double-clicks the Hive icon and the chat window appears. No terminal, no separate install, no manual daemon start.**

Mechanism:

- The daemon binary is bundled inside the Electron app package via the packager's `extraResources` mechanism. It ships *with* the app — not a separate install.
- On Electron startup, the main process **probes `localhost:3117` first**. If a daemon answers (e.g., a power user has been running `hive daemon start` headlessly), Electron attaches to it. If the port is free, Electron spawns the bundled daemon as a **hidden child process** (`windowsHide: true` on Windows; macOS/Linux open no terminal by default).
- A `spawnedByShell` flag is set when Electron starts the daemon itself. On Electron quit:
  - If `spawnedByShell === true`, Electron sends SIGTERM to the daemon, waits up to N seconds, escalates to SIGKILL if needed.
  - If `spawnedByShell === false`, Electron leaves the daemon running. The user started it; the user owns its lifecycle.
- Close window → minimize to tray; daemon keeps running (regardless of who spawned it).
- Quit from tray → triggers the cleanup above.

This is the *probe-then-spawn* model. It cleanly handles the three real compositions:

| Composition | Behavior |
|---|---|
| Pure desktop user (most users) | Open app → daemon spawned hidden → tray icon → quit kills daemon |
| Headless user attaching GUI ad-hoc | Daemon already running → open app → Electron attaches → quit leaves daemon running |
| Headless server (no GUI ever) | Daemon runs alone via `hive daemon start`; Electron never invoked |

Implementation cost: ~30 LOC plus the `extraResources` packaging entry. Rejected alternatives:

- **Always spawn fresh** — would conflict with an existing headless daemon on the port. Bad for users who run Hive on a home server and occasionally open the desktop UI.
- **Lazy-spawn on first Run** — adds cold-start latency to every "first message after opening the app" and complicates the tray-icon-status story (the icon would be "off" until you've talked to it).
- **Embed daemon in Electron's Node main process** (single process, no spawn) — forces the daemon to run in Node, abandoning Bun's built-in TS / SQLite / test runner. The two-process cost is one `spawn()` call and a localhost socket; trivial.

## Why not electron-builder

The original pick was `electron-builder` — the industry default that produces signed `.msi` / `.dmg` / `.AppImage` installers and pairs with `electron-updater`. We switched to `@electron/packager` for v1 because:

- electron-builder unconditionally downloads `winCodeSign` on Windows builds. That archive contains macOS `.dylib` symlinks the bundled `7za.exe` cannot extract without Windows Developer Mode or admin permissions.
- The failure is total — *any* Windows target (`nsis`, `dir`, `portable`) hits the same cache-extraction step.
- electron-packager bundles the app with Electron's binary into a runnable folder without any code-signing dance, which satisfies the "double-click to run" requirement without infrastructure prerequisites.

Trade-off: no installer in v1. Users get `shell/release/Hive-win32-x64/Hive.exe`, ~378 MB folder they copy and run. Acceptable for personal-scale single-author distribution. Switch back to electron-builder when a code-signing cert and a build host with the right perms exist (Developer Mode toggle on Windows, or admin-elevated CI). The packager pick is encapsulated in `scripts/ship.ts:13-22` so the swap is localized.

## What this defers

- Cloud / hosted sync. Local-first only; sync is user-driven.
- Mobile native shells. Web UI over tunnel covers v1 mobile.
- Replacement of pi-ai with own adapters. Triggered only by concrete ModelGateway friction.
- Migration off Electron (to Tauri or native). Reconsider only if Electron's bundle size or memory footprint becomes a blocking concern for the portability mission.
- Signed installers (`.msi`, `.dmg`, `.AppImage`) + auto-update. Needs signing cert + electron-builder; see "Why not electron-builder" above.

## Deferred decisions (open)

- **Memory format details** (events vs prose, tiering, INDEX shape, promotion rules). Storage layer absorbs either. Hermes Agent's memory subsystem (`plugins/memory/`, agent-curated, FTS5 session search, Honcho dialectic user modeling) is the leading public reference design to evaluate against — see CONTEXT.md "Reference projects".
- **Capability manifest schema** — particularly the shape of `providerHints` for per-provider Tool concessions (Gemini schema subset, OpenAI strict mode, Anthropic cache_control placement).
- **Secrets / auth profiles** — Hive must build its own Secrets primitive. pi-ai is stateless on disk for credentials: it reads provider env vars (`OPENAI_API_KEY` etc.) at call time, accepts `apiKey` overrides per call, and exposes OAuth primitives (`getOAuthApiKey(providerId, credentials)`) where the *caller* persists the `{refresh, access, expires}` triple. pi-ai's own CLI saves to `auth.json` in CWD, but that's a CLI convention, not a library surface. (Earlier draft of this ADR described an "auth-profiles" surface in pi-ai — that was inaccurate; no such system exists. See ADR-0003 G1.)
- ~~**Per-Agent vs per-Run model selection policy.**~~ Resolved: three-layer resolution at Run start — (1) per-Run override (transient, picked in UI), (2) Harness `config.model` + `config.modelFallback` (per-Agent default, edited via Agent Manager), (3) global deployment default. No per-Thread sticky model in v1. Backend-specific config (model name, effort, thinking budget, permission flags) lives in `harness.config` and is validated against a per-backend Zod schema. See ADR-0003 "Harness config is backend-specific and schema-driven".
- ~~**Daemon process management from Electron.**~~ Resolved (see "Daemon-from-Electron lifecycle" below).

## Verification

This stack is correct if, from a fresh checkout, the kernel can run one corp scenario and one personal scenario end-to-end (per ADR-0001's stop rule), with the inner loop under 1 s per iteration. If either fails, the picks are wrong — fix here before further commitments.
