# Work-Claw (CLAW) — Replication-Grade Feature Specification

> **Purpose.** This document set is a functional specification of every feature in the
> Work-Claw / CLAW product, written so that **a coding agent with no access to this
> codebase can re-implement the same external behavior**. It describes *what* each
> feature does and the *contracts* it must honor (wire formats, file formats, schemas,
> numeric thresholds, state machines) — not *how* the current code is organized.
>
> It was produced by reading the source at HEAD and verifying each claim against
> `file:line`, not from the README alone. Where the README and the source disagree,
> **the source wins** and the discrepancy is recorded below.

CLAW is an always-on, local-first personal AI assistant for Windows. It runs as a
background **daemon** on `localhost:3117` exposing a REST + WebSocket API, presents a
self-contained **Web UI** and an Ink-based **TUI**, and is built on top of the GitHub
Copilot SDK (`@github/copilot-sdk`) for model inference, tool execution, MCP, and auth.
On top of the SDK it adds: persistent identity & multi-tier memory, a self-learning
heartbeat, an in-daemon scheduler and lightweight triggers, a sub-agent / custom-agent /
squad orchestration layer, a tool registry with a Docker sandbox, structured task
orchestration, and an artifact store. All state lives under `~/.claw/`.

---

## How to use this spec

1. Read this overview for the system shape and the **replication caveats** (below) —
   they are the traps a re-implementer would otherwise fall into.
2. Build subsystem by subsystem using the eight section files. Each section is
   self-contained and follows the same structure: **overview → feature inventory
   checklist → per-feature entries (Purpose / Trigger / Inputs / Behavior /
   Output-effect / Edge-cases / Configuration / Dependencies / Example) → Data &
   formats appendix → Coverage notes.**
3. Treat the **Data & formats** appendices as the binding contracts. Match those exactly
   (REST/WS schemas, file formats, config schema, task state machine) and the rest
   follows.

---

## Section map

| # | File | Subsystem | What it covers |
|---|------|-----------|----------------|
| 01 | [01-daemon-api.md](01-daemon-api.md) | **Daemon, REST API, WebSocket, auth, plugins, tunnels** | Port lifecycle; 32-byte token auth; per-IP rate limiting; ~120 REST endpoints (full method/path/body/response/error table); bidirectional WS message catalog (~29 client→server, ~50 server→client); route-only plugin contract; Azure Dev Tunnel commands. |
| 02 | [02-cli-tui.md](02-cli-tui.md) | **CLI & TUI** | `claw` / `claw-daemon` subcommands & flags; one-shot `send`; `web`/`app`; daemon mgmt; onboarding wizard; 30+ slash commands with exact syntax & validation; TUI views, channels, keyboard shortcuts, prompt config. |
| 03 | [03-memory.md](03-memory.md) | **Persistent memory** | 4-tier memory; exact file formats (SOUL/USER/MEMORY/daily/weekly/monthly, `structured.json`); importance-metadata comment format; dedup-aware writes; fuzzy section matching; relevance-ranked search; tiered compaction; context-budget allocation; GC; memory tools. |
| 04 | [04-agents-squads.md](04-agents-squads.md) | **Sub-agents, custom agents, squads, model routing** | 6 built-in roles; concierge triage rule; delegation depth (2); custom-agent `*.md` frontmatter schema; `create_custom_agent`; retry/escalation limits; squad config/state/tools/handoff (3); role→model routing + per-channel overrides. |
| 05 | [05-scheduler-heartbeat.md](05-scheduler-heartbeat.md) | **Scheduler, triggers, heartbeat** | Schedule schema & frequencies; v1→v2 migration; Run-Now; trigger polling contract (≥5s, exit-code semantics, 4KB cap, 30s cooldown); the full heartbeat action set with per-action behavior & cadence. |
| 06 | [06-tools-tasks.md](06-tools-tasks.md) | **Tool registry, MCP, Docker, tasks, artifacts** | Every built-in tool with param schema; availability detection; `tools.json` / MCP schema; `docker_exec` sandbox; artifact store + frontmatter; structured task object + full lifecycle state machine; legacy `TASKS.md`. |
| 07 | [07-web-ui.md](07-web-ui.md) | **Web UI (SPA)** | ~18 routable views (more than the README's "10"): Chat, Events, Stream, Agents, Skills, Sessions, Schedules, Memory, Tasks, Settings, Permissions, Tools, Artifacts, Pins, Usage, Squad, Plugin Gallery, Agency Terminal, World, Channel Manager — each with controls→endpoint mapping, shortcuts, real-time behavior. |
| 08 | [08-config-identity-platform.md](08-config-identity-platform.md) | **Config, identity, channels, providers, permissions, platform** | Complete `claw.json` schema; soul files & system-prompt assembly; channels data model & per-channel overrides; BYOK provider schema; permission engine & escalation; audit log format; Windows desktop app; install/setup/update/uninstall flows. |

---

## Consolidated feature inventory (top level)

**Runtime & transport** — Background daemon (`localhost:3117`, port-bind retry); REST API
(~120 endpoints); WebSocket realtime (auth handshake, per-channel FIFO, broadcast to all
clients); token auth (32-byte hex, `daemon.json`, constant-time compare, loopback vs
remote gating); per-IP rate limiting; route-only plugins (`/api/extensions/:id/...`);
Azure Dev Tunnel remote access.

**Surfaces** — Web UI SPA (~18 views, hash-routed, mobile drawer, live WS updates); Ink
TUI (streaming, channels, 30+ slash commands, keyboard nav); one-shot CLI `send`; native
Windows desktop app (WebView2 + system tray, single-instance); daemon lifecycle CLI.

**Intelligence & memory** — 4-tier memory (working / long-term prose / structured JSON /
skill); context-budget system-prompt assembly; importance scoring; dedup-aware writes;
fuzzy section matching; relevance-ranked search with synonym expansion; tiered compaction
(daily→weekly→monthly); hard size enforcement + overflow sidecars; weekly garbage
collection.

**Autonomy** — Self-learning heartbeat (reflect/learn, memory maintenance, task work &
monitoring, skill evolution, workspace cleanup); in-daemon scheduler (minute…once,
in-process AI sessions, Run-Now, review gating); lightweight triggers (LLM-free polling
watchdogs).

**Agents & orchestration** — 6 built-in roles; concierge-first delegation; hierarchical
sub-agents (depth 2); custom agents (`~/.claw/agents/*.md`); self-created agents; squad
channels (roster, agent-driven routing, handoff depth 3, autonomy metadata, squad tools,
dashboard); role→model routing + per-channel model/reasoning overrides.

**Tasks & tools** — Structured task store (full lifecycle state machine, assignment,
progress check-ins, dependencies, auto-close, board summary); tool registry with
availability detection & per-tool enable/disable; MCP servers (native via SDK); Docker
sandbox (`docker_exec`); artifact store (date-organized, YAML frontmatter, auto-tagged).

**Configuration & governance** — Complete `claw.json` config; soul/identity files;
per-channel config & tool filtering (allowlist beats blocklist); BYOK custom providers;
permission engine + escalation policy; append-only audit log; first-run onboarding;
install / setup / update / uninstall scripts.

---

## Replication caveats — README vs. verified source behavior

The README is an accurate map of *intent* but **overstates or misstates several current
behaviors**. A re-implementer who codes to the README alone will get these wrong. Each was
verified against source at HEAD. Decide per item whether you are replicating the
**documented intent** or the **shipped behavior** — they differ.

| Area | README says | Source at HEAD actually does | Section |
|------|-------------|------------------------------|---------|
| **Heartbeat actions** | Honors the configured `actions` array & `enabled` flag | `HeartbeatEngine.start()` **forces** `enabled:true` and ignores config, always running the hardcoded `DEFAULT_HEARTBEAT.actions` list. `memory_gc` & `pr_status_summary` are implemented but **not** in that runtime list, so they never fire on a default tick. | 05 |
| **Squad routing** | Pattern-based regex routing with priority + `fallbackAgent` | **No routing rules exist.** Migration code actively deletes legacy `routing`. Routing is purely agent-driven via the `squad_route` tool. `leadAgent` exists; `fallbackAgent` does not. Roster members are `{agent, role}` only (no `capabilities`). | 04 |
| **Squad autonomy levels** | supervised / semi-autonomous / autonomous operation | Stored & displayed but **not enforced** anywhere in the spawn/route path — metadata only. | 04 |
| **Squad heartbeat / dashboard** | Persistent Squad-Monitor-compatible state incl. live status | `heartbeat.json` is **never written** (no callers); dashboard `activeAgents` is always `[]` (live status comes from `/api/agents/active`). Other state files *are* written. | 04 |
| **BYOK custom provider** | `provider{type,baseUrl,apiKey,bearerToken}`; bearerToken > apiKey; model required | **Inert.** Not in `ClawConfig`, never parsed/validated/passed to the SDK. Only side effects: API rejects it as a forbidden key, and redaction masks `apiKey` (but leaks `bearerToken`). The precedence rules are documentation-only. | 08 |
| **Escalation config** | `escalation{default, high_complexity, low_complexity, log_all_actions}` drives gating | Only `escalation.default` is read. The other three fields are **dead config**. Real authorization is a separate `PermissionEngine` (5-level autonomy dial, `permissions.json`). Audit logging is unconditional. | 08 |
| **Memory tools** | implies `memory_compact` and `memory_search` tools | Neither exists as a tool. Compaction is `memory_write mode="compact"`. There are **two** different search paths (`searchMemory` scored vs `searchAllMemory` substring) — don't conflate them. | 03 |
| **Context budget** | "~10K tokens total" | Actual `SECTION_BUDGETS` sum is **11,750 tokens**. | 03 |
| **Tool enable/disable endpoint** | `POST /api/tools/:name/toggle` | Live SPA calls `PUT /api/tools/:name {enabled}`. | 01, 07 |
| **Web UI view count** | "Web UI (10 views)" | The shipped SPA has **~18 routable views** (Skills, Permissions, Pins, Usage, Plugin Gallery, Agency Terminal, World, Channel Manager, etc. beyond the 10). | 07 |
| **Default model** | example `claw.json` shows `claude-sonnet-4.5` | Source default is `claude-sonnet-4.6`; onboarding fixes `claude-sonnet-4.6`. | 02, 08 |
| **TUI slash commands** | a subset table | Source has 30+ commands; the in-TUI command *palette* component exists but is never wired (commands run by typing full text + Enter). | 02 |
| **`docker_exec` languages** | "Python, Node, Bash, Ruby" | Enum also accepts `sh`; a `go` image mapping exists but `go` is unreachable (not in the enum). | 06 |
| **Trigger timeout field** | `timeoutSeconds` in examples | Runtime `TriggerSpec` consumes `timeoutMs` (default 10000ms). | 05 |
| **Idle-bound REST routes** | (n/a) | `POST /api/browse-folder` and `POST /api/migrate-data` (triggers daemon restart) are host-affecting but gated by **token only**, not `requireLocalOrOptIn`. | 01 |
| **Uninstall** | removes auto-start | `uninstall.ps1` removes only the legacy `CLAW_Daemon` task, not the current `Work-Claw Daemon Watchdog` task or the `claw-daemon.vbs` Startup launcher. | 08 |

---

## Build / runtime stack (context, not a feature)

- **Runtime:** Node.js ≥ 22 (ESM). **Language:** TypeScript 5.9 (strict). **Bundler:** tsup.
- **AI backend:** GitHub Copilot SDK (`@github/copilot-sdk` 1.0.1) + bundled Copilot CLI.
- **TUI:** Ink 6 + React 19. **Web UI:** vanilla-JS SPA concatenated from `src/web/js/*`
  into a single self-contained `index.html` (no framework build step) by `src/web/build.js`.
- **Storage:** files under `~/.claw/`; `better-sqlite3` available; schema validation via Zod 4.
- **Tests:** Vitest (unit / integration / regression / e2e) + Playwright (UI e2e). `npm test`
  must pass before commit.
- **Platform packaging:** native Windows desktop app under `tools/claw-desktop/`
  (.NET 8 WinForms + WebView2); PowerShell install/setup/update/uninstall scripts.

---

## Coverage boundaries

These were intentionally treated as out of scope or only described behaviorally (each
section's **Coverage notes** has the detail):

- Anything owned by the **GitHub Copilot SDK** (session/streaming/compaction internals,
  permission-prompt plumbing, MCP protocol, the allowlist-beats-blocklist tool-filter rule
  which lives in the SDK) — described by its observable contract only.
- **Memory topic-graph / knowledge-base / FTS** internals (the most entangled adjacent
  area) — noted where they branch specced behavior.
- OS-level **auto-start install mechanics** and **C# desktop internals** — observable
  behavior only.
- A few peripheral REST namespaces (usage aggregates, agency gallery/publish, parts of
  comm-channels/permissions) — paths and intent are authoritative; some nested response
  body field names were read from client call sites and are indicative, not transcribed.
