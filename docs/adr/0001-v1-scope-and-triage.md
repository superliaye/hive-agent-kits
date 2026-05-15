# v1 Scope — Tauri Greenfield + Scenarios

## What this ADR records

Two commitments and a posture:

1. **Build brand new**, not refactor anything. Closer to work-claw in *vision*, but a fresh codebase.
2. **Tauri desktop app + embedded daemon** as the runtime shape. Single binary, cross-platform (Mac + Windows). Same binary runs windowless for headless use.
3. **Posture toward work-claw:** its feature inventory is *reference material* — a checklist to re-evaluate against our scenarios. Not a porting plan. Each feature gets re-judged from first principles: do we need this? When? Implemented how, given our architecture?

## Runtime shape

- **Tauri** as the framework. Rust core, webview UI, TypeScript frontend.
- **Daemon embedded in the desktop process.** Launch = window opens, daemon starts. Close window = minimize to tray; background work continues (scheduler, async runs). Quit from tray = daemon stops.
- **Same binary, headless mode** (`hive --no-gui` or similar) for servers, CI, dev tunnels.
- **HTTP boundary** inside the process for: web tab access, mobile-over-tunnel, CLI shots from terminal.
- **Native install + auto-update** via Tauri's bundler and updater.
- **Cross-platform from day one.** Mac + Windows. Linux later.

## Scenarios (the design pressure)

These are the only things the architecture has to serve. Any choice that doesn't help these is suspect.

- **Corp dev daily** — 25 scenarios. Microsoft / WEX-flavored. See [`docs/scenarios-corp.md`](../scenarios-corp.md).
- **Personal productivity** — 18 scenarios. Same person, non-work life. See [`docs/scenarios-personal.md`](../scenarios-personal.md).

## Reference material (not blueprints)

- **work-claw feature inventory** — ~150 features triaged in an earlier pass. Treat the Core / Useful / Nice / Skip labels as *starting hypotheses*, not commitments. Each feature is re-evaluated against the scenarios when its turn comes. See [`docs/inventory-workclaw.md`](../inventory-workclaw.md).

## v1 in scope (kernel commitments)

- The architecture vocabulary from `CONTEXT.md`: Agent, Agent Harness, Memory (per-Agent), Capability Registry (Personal/Workplace origin), Thread, Run, Agent Catalog, Root Agent + Agent Manager
- Tauri shell with embedded daemon
- One LLM provider adapter (Anthropic SDK first; provider abstraction allows others later)
- Local data store with per-Agent Memory partitions
- One Web UI surface — chat + Agent Catalog browser + minimal Capability Registry view
- TUI / CLI fallback for headless mode

## v1 must resolve (architectural blockers)

These were surfaced by inventory analysis. The portability mission cannot ship without them.

1. **Sync/migration** of Personal-origin Capabilities + Memory across deployments
2. **Secrets management** (Capabilities depend on credentials; not yet specified)
3. **Capability Registry versioning** + Personal/Workplace name-collision policy
4. **Concurrent-Run write coordination** on Memory (model allows concurrent Runs; semantics unstated)
5. **INDEX definition** (used by the Librarian Memory Model; never formally defined)
6. **Agent Harness "template" vs "instance"** disambiguation (the example dialogue treats `code` as a clonable template; the formal definition uses the same noun for both)

## v1 out of scope

- Cloud sync as a hosted service (local-first only; sync is user-driven)
- Mobile native shells (web UI over tunnel is the v1 mobile story)
- Multi-user / team features
- Microsoft-internal agents — those are Workplace-origin examples, not kernel content
- Anything from the work-claw inventory previously labeled "Skip" *unless* a scenario forces a re-look

## v2+ candidates (re-evaluate from work-claw inventory when phase 3 starts)

Open questions to revisit, not commitments:

- Squad-channels-style multi-agent thread mode
- Tiered memory (daily → weekly → monthly summaries) inside per-Agent partitions
- Heartbeat actions (reflect_and_learn, memory_maintenance, etc.)
- Trust pattern learning (auto-suggest after N approvals)
- Semantic search (Ollama + sqlite-vec + hybrid RRF)
- MCP server watchdog
- Generalization regression test (scans for forbidden personal/team literals — directly aligned with portability mission)

## Build order

**Phase 1 — Kernel (2–3 weekends).**
Minimal Tauri shell + CLI. Agent Catalog, one Agent, one Thread, one Run loop against Anthropic SDK. v1 blockers (1)–(6) addressed in design at minimum, in code where load-bearing.

**Phase 2 — UI surfaces.**
Web UI: chat, Agent Catalog browser, Capability Registry view, Sessions/Threads browser. Tray icon. Auto-start on login. Permissions + approval modal. Audit log.

**Phase 3 — Selective feature evaluation.**
Walk the work-claw inventory feature by feature. For each: does it serve a scenario? If yes — implement against our architecture (not by porting code). If no — drop.

**Stop rule:** at the end of Phase 1, the kernel must run at least **one corp scenario and one personal scenario end-to-end**. If it can't, the kernel is wrong. Fix before any UI work.
