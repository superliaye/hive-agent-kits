# Work-Claw (CLAW) Feature Inventory & Triage for Hive

Source documents reviewed: `D:\GitRepos\work-claw\README.md`, `PLAN.md`, `CHANGELOG.md` (v0.17.0 → v0.30.0), `INSTALL.md`, `HELP.md`.

## Triage Criteria

Hive is a greenfield kernel built on a different identity model than CLAW:

- **Agent** = identity + Agent Harness + per-Agent Memory partition (keyed by Agent identity, **not** shared across agents).
- **Capabilities** (Skills, Tools, MCP Servers, Agent Harness templates) carry a **Personal** or **Workplace** origin tag so they can travel with the user across companies.
- Vocabulary follows OpenAI Threads/Runs (a Thread is a persistent conversation owned by an Agent; a Run is one execution).
- Portability across companies and repos is the core differentiator.
- Two specialized agents bootstrap the system: **Root Agent** (user entry-point) and **Agent Manager** (lifecycle).

Each CLAW feature below is classified as:

- **Core** — must exist in Hive v1 for parity with CLAW's value proposition.
- **Useful** — likely include after v1; valuable but not blocking.
- **Nice-to-have** — defer or accept as a stretch goal.
- **Skip** — explicitly out-of-scope for Hive (conflicts with the architecture, redundant under the new model, or out-of-mission).

The "Note" column gives the v1 rationale and (for Skip) the conflict in one line.

---

## Inventory

| Feature | Category | Triage | Note |
|---|---|---|---|
| Background daemon on `localhost:3117` (HTTP + WebSocket) | Daemon / infra | Core | Hive needs a long-lived process to host Agents, Runs, and Memory; HTTP+WS surface is the natural choice. |
| Multi-client over single daemon (Web UI + TUI share session) | Daemon / infra | Core | Threads are persistent; multiple clients attaching to the same Run is table stakes. |
| Auto-start on login (Windows scheduled task / launchd / etc.) | Daemon / infra | Useful | Important for "always-on" feel but can land after v1. |
| Azure Dev Tunnels remote access (`tunnel enable/disable/status/url`) | Daemon / infra | Skip | Couples to Microsoft Dev Tunnels; pick a generic exposure later or rely on user's own reverse proxy. |
| Dev Tunnel auth recovery & expired-token detection | Daemon / infra | Skip | Only relevant if Dev Tunnels ship; skipping the parent feature. |
| Tunnel URL surfaced in `daemon status` / health endpoint | Daemon / infra | Skip | Same as above. |
| Daemon lifecycle CLI (`start`, `stop`, `restart`, `status`, `install`, `uninstall`) | Daemon / infra | Core | Required to operate a daemon-based system. |
| Token-based daemon auth (`~/.claw/.token`, chmod 0600) | Permissions / audit | Core | Local daemon must auth clients; lift the pattern. |
| CORS restricted to localhost + tunnel origin; CSP, X-Frame-Options, X-Content-Type-Options | Permissions / audit | Useful | Standard hardening; can be in v1 but not blocking. |
| API key redaction on `/api/config` | Permissions / audit | Core | Any BYOK config endpoint needs this from day one. |
| Path traversal guard (`isWithinBase` via `path.resolve`) for memory/artifact paths | Permissions / audit | Core | Memory I/O surface needs this. |
| Windows MSI installer with bundled Node, gh, devtunnel, WinSW service | Onboarding | Skip | Premature for a kernel-stage project; we will ship via `npm i -g` or source. |
| macOS `.pkg` installer with LaunchAgent | Onboarding | Skip | Same — packaging belongs after kernel stabilizes. |
| `setup.ps1` / `setup.sh` prerequisite installer (winget / brew / apt detection) | Onboarding | Nice-to-have | A convenience script can come later; document manual steps first. |
| First-run onboarding wizard (name agent, pick emoji) | Onboarding | Useful | Hive needs *some* first-run flow but it should set up Root Agent identity, not aesthetics. |
| Native Windows desktop app (WebView2, system tray, single-instance) | UI surfaces | Skip | Web UI in any browser covers the use case; tray app is post-v1. |
| Web UI SPA (self-contained `index.html`, no build) | UI surfaces | Core | Hive needs a browser UI; the zero-build single-file approach is a strong fit for the kernel. |
| Ink-based TUI with shared session via daemon | UI surfaces | Useful | Power-user surface; valuable but second priority to Web UI. |
| One-shot CLI (`claw send "..."`) | UI surfaces | Useful | Scripting hook is cheap to add. |
| Chat view: streaming markdown, reply-to, image paste, file attach, timestamps, model selector, verbose toggle, Esc-to-stop, Alt+S speech-to-text | UI surfaces | Core | Core chat surface for a Thread. Speech-to-text is nice-to-have inside this bundle. |
| Events panel (collapsible right-side panel with tool calls, sub-agent events, cancel buttons) | UI surfaces | Useful | Keeps chat clean; Hive's many capability calls per Run will need similar surfacing. |
| Raw Stream view (real-time tool calls, chunks, reasoning, filters, color badges) | UI surfaces | Useful | Debug surface; valuable for kernel development. |
| Agents view (built-in/custom, profiles, spawn, manage, active sub-agents bar) | UI surfaces | Core | Becomes the **Agent Catalog** browser in Hive. |
| Sessions view (sub-agent and scheduled job transcripts, filtering) | UI surfaces | Core | Becomes the **Thread / Run** browser in Hive. |
| Schedules view (CRUD, enable/disable, run now, history) | UI surfaces | Useful | If scheduling lands, it needs a UI. |
| Memory view (browse/edit per-file, full-text search) | UI surfaces | Core | Hive Memory needs an inspector; format-aware. |
| Memory Graph tab (Cytoscape force-directed topic graph, click for detail) | UI surfaces | Skip | Tied to CLAW's topic-graph memory; conflicts with per-Agent Librarian memory model. Revisit after memory format decision. |
| Memory Audit tab (last 50 entries with timestamps, load more) | UI surfaces | Useful | Per-Agent memory mutations should be auditable; reuse pattern. |
| Tasks view (board, status grouping, progress bars, assignee, detail modal) | UI surfaces | Useful | Only if Hive adds task orchestration; defer. |
| Settings view (identity, model, reasoning effort, heartbeat, escalation) | UI surfaces | Core | Hive needs a settings surface. |
| Tools view (status badges, enable/disable, MCP CRUD) | UI surfaces | Core | Becomes the **Capability Registry** browser in Hive. |
| Artifacts view (date-grouped, tag filtering, detail view) | UI surfaces | Useful | Run outputs need a home; defer if Threads cover it. |
| Reasoning Inspector slide-out panel per assistant message (tool calls / agent activity / chain) | UI surfaces | Useful | Strong UX; lift after Core. |
| Pin Messages with folder organization | UI surfaces | Nice-to-have | Niche feature; defer. |
| Usage Dashboard (token & cost tracking, per-model breakdown, SQLite store) | UI surfaces | Useful | Cost visibility matters once Hive sees real usage. |
| Health view (heartbeat + maintenance messages routed off main chat) | UI surfaces | Useful | Good pattern once Hive has background work. |
| Mobile responsive CSS (slide-out sidebar, 44px tap targets, slide-in detail panels, browser back integration) | UI surfaces | Nice-to-have | Defer until web UI shape is stable. |
| Dark/light theme toggle, dynamic favicon/splash from agent emoji | UI surfaces | Nice-to-have | Polish. |
| Sticky channel via URL hash routing | UI surfaces | Nice-to-have | Polish. |
| Channel busy indicator (spinner + amber highlight in sidebar) | UI surfaces | Useful | Becomes per-Thread busy state. |
| Per-channel text input draft state | UI surfaces | Nice-to-have | Polish. |
| Message injection mid-turn (interrupt with COURSE CORRECTION marker) | Task orchestration | Useful | Powerful Run-control primitive; consider for v1.1. |
| Message queue (queue messages while agent is busy, badge with depth) | Task orchestration | Useful | Pairs with injection. |
| Channels (topic-based threads, system prompt overlay, tool allow/blocklist, independent history) | Agents | Core | **Map directly to Hive Threads** — each Thread per Agent already covers this. CLAW's "channel" ≈ Hive's "Thread". |
| Per-channel tool filtering (`availableTools` / `excludedTools`) | Agents | Skip | Hive: tool access is determined by Agent Harness, not per-Thread. Conflicts with the Capability binding model. |
| Channel context refresh via WebSocket (`refresh_channel_context`) | Agents | Useful | Useful for live-editing Thread instructions. |
| Working memory (SDK infinite sessions, automatic context compaction) | Memory | Core | Hive needs equivalent context-window management inside each Run. |
| Long-term prose memory files (`USER.md`, `MEMORY.md`, daily logs) | Memory | Skip | Conflicts with per-Agent Memory model — there is no single global `USER.md`; user-facts live per-Agent or in a Personal-origin shared Capability. |
| `SOUL.md` (agent personality/identity prose) | Memory | Skip | Subsumed by Agent Harness (system prompt + identity) in Hive. |
| `AGENTS.md` (operating rules) | Memory | Skip | Subsumed by Agent Harness. |
| `BOOT.md` startup ritual checklist | Memory | Skip | Implicit in Run startup; no separate file. |
| Structured memory (`structured.json` — people, projects, preferences, facts) | Memory | Useful | Concept is sound; reshape as a Personal-origin Capability so it travels with the user. |
| Per-agent skill memory in `~/.claw/skills/<agent>/` | Memory | Core | Maps to per-Agent Memory partition keyed by Agent identity. |
| Daily logs → weekly → monthly tiered summarization (logarithmic compression) | Memory | Useful | Strong pattern for long-term retention; revisit after memory model is locked. |
| Importance scoring (`<!-- importance: high | last-referenced: ... -->`) for priority-based truncation | Memory | Useful | Reusable mechanic regardless of memory shape. |
| Context budget allocator (~10K total, per-section token limits, smart TOC expansion) | Memory | Core | Hive's Run setup needs this when assembling Memory + Skills into context. |
| Hard size enforcement with auto-compaction + lowest-priority truncation | Memory | Useful | Defensive; lift once memory writes are wired. |
| Dedup-aware writes (line-level overlap detection before append) | Memory | Useful | Cheap, valuable. |
| Fuzzy section matching (case-insensitive header match for `section_update`) | Memory | Nice-to-have | Convenience for prose-file memory; only if we keep prose. |
| Relevance-ranked keyword search with synonym expansion across all tiers | Memory | Useful | Strong default search; lift. |
| Memory garbage collection (stale facts, cross-store duplicates, conflicting prefs, empty sections) | Memory | Useful | Defer until memory writes exist. |
| Quality filtering (strip agent filler text, cap log entries at 2KB) | Memory | Nice-to-have | Polish. |
| Semantic search (Ollama embeddings, sqlite-vec, hybrid RRF over keyword+semantic, query-term re-rank) | Memory | Useful | High-value but heavy; ship after keyword search. |
| Memory audit log (every fact extracted / topic created / merged / GC run) | Memory | Useful | Per-Agent Memory mutations should be auditable. |
| Graph-based topic memory (`memory/topics/<id>.md` with frontmatter, LLM extractor, Jaccard consolidation, GC, index file) | Memory | Skip | Specific shape conflicts with the Librarian per-Agent model we're trending toward. Deferred memory decision. |
| Source connectors (agent-aware source discovery, auto-enable, harvest from archived MEMORY/daily logs/sessions) | Memory | Skip | Tied to the topic-graph memory model. |
| SQLite WAL mode + periodic checkpoint for memory store | Memory | Useful | If memory backend ends up SQLite-backed. |
| Write interception (`memory_write(TASKS.md)` → redirect to structured task system) | Memory | Skip | Migration artifact specific to CLAW's legacy file. |
| 6 built-in agent roles (Researcher, Developer, QA, Writer, Architect, Security Analyst) with personality/goal/strengths | Agents | Useful | Provide as **Personal-origin Agent Harness templates** in the Capability Registry — not hardcoded roles. |
| Concierge-first / orchestrator architecture (main agent triages, delegates) | Agents | Core | Maps to Hive's **Root Agent** pattern. |
| Hierarchical sub-agent delegation (depth limit 2) | Agents | Core | Hive Runs delegate to other Agents; need depth/loop guards. |
| Custom agents as `~/.claw/agents/*.md` (YAML frontmatter + system prompt + model override) | Agents | Core | Becomes Hive Agent Harness files; lift the format with Capability-binding section. |
| Self-learning: agent creates new custom agents from experience (`create_custom_agent` tool, heartbeat `skill_evolution`) | Agents | Useful | Becomes the **Agent Manager**'s job; lift, but gate behind explicit user approval. |
| Active agents panel (running sub-agents, elapsed time, instant cancel) | Agents | Core | Becomes the active-Runs panel. |
| Smart retry limits (escalate to user after repeated failures) | Agents | Useful | Token-burn guard. |
| Community agents catalog (browse, one-click install, scripts + data bundles) | Agents | Nice-to-have | Defer; first focus on the Capability Registry primitives. |
| Bundled agent skill scripts (`.ps1` helpers copied to `~/.claw/skills/<agent>/`) | Agents | Useful | Maps to Personal-origin Capability bundles. |
| `run_script` tool (agent executes bundled scripts, 300s timeout, output returned) | Agents | Useful | Reasonable Capability primitive. |
| Built-in `icm-oncall`, `icm-incidents`, `teams-messenger` agents | Agents | Skip | Microsoft-specific — Workplace-origin example agents, not core kernel. |
| Agent trust profiles (0-100 score, +0.5/success, −2/failure, per-agent autonomy overrides) | Permissions / audit | Useful | Strong concept; defer to v1.1 once base permissions ship. |
| Squad Channels (transform channel into persistent agent team) | Squad channels | Skip | Overlaps heavily with Hive's Root Agent → other Agents model and Threads. Re-evaluate as a multi-Agent Thread mode later. |
| Configurable squad roster (per-channel agent list with roles/capabilities) | Squad channels | Skip | Same. |
| Pattern-based routing rules (regex with priority, ReDoS protection, 10K input cap) | Squad channels | Nice-to-have | Concept is portable to Root Agent routing; lift the idea, drop the channel-scoping. |
| Lead agent fallback for unmatched routing | Squad channels | Skip | Subsumed by Root Agent. |
| Agent handoffs via `squad_route` (max depth 3, follow-up tasks with `parentTaskId`/`dependsOn`) | Squad channels | Skip | Replaced by Hive Run→Run delegation. |
| Squad-aware spawn budget (`maxConcurrentAgents`) | Squad channels | Useful | Concurrency cap is portable. |
| Persistent squad state files (`team.md`, `routing.md`, `decisions.md`, `orchestration-log.md`, `activity.log`, `heartbeat.json`, per-agent history, shared skills) | Squad channels | Skip | Belongs to the squad model. |
| Autonomy levels per-squad (supervised / semi-autonomous / autonomous) | Squad channels | Skip | Use the global Permissions autonomy dial instead. |
| Squad Dashboard (roster cards, task summary, recent decisions, activity timeline, vertical layout, collapsible icon strip) | Squad channels | Skip | Dashboard pattern itself is reusable; the squad concept is not. |
| Squad Settings UI (configure roster, routing, autonomy, repo) | Squad channels | Skip | N/A under Hive model. |
| TUI squad status bar | Squad channels | Skip | N/A. |
| 5 squad tools (`squad_route`, `squad_decide`, `squad_memory`, `squad_status`, `squad_skill`) | Squad channels | Skip | N/A. |
| Squad REST API (`/squad/init`, `/squad`, `/squad/status`, `/squad/dashboard`) | Squad channels | Skip | N/A. |
| Structured task store (JSON-persisted, channel-scoped, lifecycle `pending → assigned → in_progress → blocked → review → done/failed/cancelled`) | Task orchestration | Useful | Generic backlog primitive; defer to v1.1. |
| Task agent assignment with `task_progress` tool for sub-agent check-ins | Task orchestration | Useful | Useful for long Runs. |
| Auto-close task when assigned sub-agent completes/fails | Task orchestration | Useful | Pairs with above. |
| Task dependencies (`dependsOn`) with heartbeat readiness monitoring | Task orchestration | Useful | Defer. |
| Task board grouped by status with progress bars, priority badges, detail modal (cancel/retry/complete/delete) | Task orchestration | Useful | UI shell for the above. |
| Task inline editing (title/desc/priority/channel) | Task orchestration | Nice-to-have | Polish. |
| Task swim lanes (Inbox/Queued/Running/Done/Failed/Cancelled) | Task orchestration | Nice-to-have | Polish. |
| Task comments & activity log | Task orchestration | Nice-to-have | Polish. |
| Task archive (don't delete, restore from archive view) | Task orchestration | Nice-to-have | Polish. |
| Task bulk operations (multi-select, group select-all, floating bulk action bar) | Task orchestration | Nice-to-have | Polish. |
| Task execution engine (queue, `maxConcurrentTasks`, status transitions, channel-scoped reporting) | Task orchestration | Useful | If tasks land, this is needed. |
| Real-time task event broadcast over WebSocket | Task orchestration | Useful | Pairs with task UI. |
| Heartbeat: configurable periodic wake-up (default 15min, enable/disable, action list) | Scheduling | Useful | Hive equivalent: periodic background Run. Defer past v1 unless self-improvement is in scope. |
| Heartbeat action: `reflect_and_learn` (updates USER/MEMORY/SOUL) | Scheduling | Skip | Tied to CLAW's prose-file memory model. |
| Heartbeat action: `memory_maintenance` (daily→weekly→monthly compaction, archival) | Scheduling | Useful | Reusable once memory model is locked. |
| Heartbeat action: `memory_size_check` (auto-compact files exceeding thresholds with importance-aware pruning) | Scheduling | Useful | Lift the mechanic. |
| Heartbeat action: `memory_gc` (weekly: stale facts, cross-store dupes, conflicts, empty sections) | Scheduling | Useful | Lift the mechanic. |
| Heartbeat action: `stale_task_check` (identify stuck tasks, suggest resolution) | Scheduling | Nice-to-have | Only if tasks ship. |
| Heartbeat action: `work_open_tasks` (auto-pick up open tasks and work them) | Scheduling | Nice-to-have | Aggressive automation; gate behind explicit opt-in. |
| Heartbeat action: `monitor_tasks` (stale check-ins → blocked, flag ready-for-assignment, report failures) | Scheduling | Nice-to-have | Only if tasks ship. |
| Heartbeat action: `skill_evolution` (daily: review sub-agent sessions, create/improve custom agents) | Scheduling | Useful | Becomes Agent Manager's nightly job. |
| Heartbeat action: `cleanup_workspace` (move stray files to `tmp/`, prune old temp) | Scheduling | Useful | Cheap defensive housekeeping. |
| Heartbeat action: `daily_checkin` | Scheduling | Nice-to-have | UX feature; defer. |
| Heartbeat shutdown recovery (`lastSeen` timestamp, >1h downtime audit note, >4h expands daily-checkin window) | Scheduling | Useful | Defensive against laptop hibernation. |
| Nightly missed-job catch-up (scheduler detects and fires jobs missed during downtime) | Scheduling | Useful | Lift. |
| In-daemon scheduler (minute / hourly / daily / weekly / monthly / once frequencies) | Scheduling | Useful | Cron-like primitive belongs in v1.1; not v1. |
| Scheduler Run Now button | Scheduling | Useful | Pairs with scheduler UI. |
| Triggers — silent watchdog scripts (min 5s interval, exit 0+stdout → submit as message) | Triggers | Useful | Very lightweight event source; lift as v1.1. |
| Trigger safeguards (30s startup cooldown, 4KB output cap, shared concurrency guard) | Triggers | Useful | Pair with triggers. |
| Trigger schema migration (bare array v1 → versioned envelope v2) | Triggers | Skip | Migration artifact; N/A for greenfield. |
| Two-tier scheduler tick loop (60s for jobs, 5s for triggers) | Triggers | Useful | Implementation pattern, lift. |
| Built-in tools: `memory_read`, `memory_write`, `memory_search` | Tools / MCP | Core | Memory access primitives belong in v1 as Personal-origin Capabilities. |
| Built-in tool: `structured_memory` (people/projects/preferences/facts CRUD) | Tools / MCP | Useful | Becomes a Personal-origin Capability. |
| Built-in tool: `task_manage` (CRUD + assign/complete/cancel) | Tools / MCP | Useful | Only if tasks ship. |
| Built-in tool: `task_progress` | Tools / MCP | Useful | Pairs. |
| Built-in tool: `schedule_manage` | Tools / MCP | Useful | Pairs with scheduler. |
| Built-in tool: `save_artifact` / `list_artifacts` | Tools / MCP | Useful | Run output persistence. |
| Built-in tool: `ask_user` (interactive question, wait for answer) | Tools / MCP | Core | Need this primitive in v1 for Run pause/resume. |
| Built-in tool: `create_custom_agent` | Tools / MCP | Useful | Becomes an Agent Manager capability. |
| Built-in tool: `spawn_sub_agent` (delegate to a sub-agent) | Tools / MCP | Core | Becomes Hive's Run-spawns-Run primitive. |
| CLI auto-detection: `github_query` (via `gh`), `docker_manage`, `docker_exec`, `powershell`, `grep`/`glob`, `view`/`edit`/`create`, `web_fetch` | Tools / MCP | Useful | Lift detection pattern as Capability availability checks; do not hardcode the CLIs. |
| Docker sandbox (`docker_exec` runs code in Python/Node/Bash/Ruby containers, isolated, with 11 blocked flags + root mount block) | Tools / MCP | Useful | Strong sandbox; lift as a Personal-origin Capability. |
| MCP server CRUD via UI + `tools.json` (stdio / http / SSE transports) | Tools / MCP | Core | MCP is first-class in Hive's Capability Registry. |
| MCP server watchdog (PID polling of `node.exe` children, auto-reconnect with exponential backoff up to 3 retries, race-condition guards) | Tools / MCP | Useful | Excellent reliability win; lift after MCP support is wired. |
| MCP `cmd.exe` popup-storm fix on Windows (direct `node.exe` invocation, auto-migrate `tools.json`) | Tools / MCP | Useful | Defensive on Windows; lift if we hit it. |
| Tool enable/disable per-tool + re-scan endpoint | Tools / MCP | Useful | Capability Registry needs this. |
| `5-level Autonomy Dial (Strict / Supervised / Balanced / Autonomous / YOLO) | Permissions / audit | Core | Strong shape; lift wholesale. |
| 14 action categories (file_read/write, shell_read/write, git_read/write, external, mcp_tool, docker, memory, agent_spawn, agent_lifecycle, system_config, destructive) | Permissions / audit | Core | Pattern is sound; tweak names for Hive vocabulary. |
| Permission engine classifier (categorize every tool call) | Permissions / audit | Core | Pairs with autonomy dial. |
| Custom + learned policy rules (priority, pattern matching, channel/agent scoping) | Permissions / audit | Useful | Drop "channel" scoping; keep agent scoping. |
| Approval modal (one-time / always-allow / session-trust / deny) | Permissions / audit | Core | Standard UX, lift. |
| Trust pattern learning (auto-suggest after 3 repeated approvals) | Permissions / audit | Useful | UX win; lift after Core dial. |
| Credential redaction in tool args (tokens, keys, secrets) | Permissions / audit | Core | Audit log + UI must not leak secrets. |
| Append-only audit log (`audit.log`) of every tool call via `onPostToolUse` hook | Permissions / audit | Core | Foundational. |
| Audit log archival, enrichment, filtering, rolling 1000-entry buffer | Permissions / audit | Useful | Pair with audit log. |
| Pre-tool dangerous-command guardrails (block `rm -rf`, `drop database`, `format`, `shutdown`, etc.) via `onPreToolUse` | Permissions / audit | Useful | Hard guardrails independent of autonomy dial. |
| Error recovery hook (`onErrorOccurred`: retry recoverable, log all failures) | Permissions / audit | Useful | Reliability pattern, lift. |
| 17+ TUI slash commands (`/model`, `/memory`, `/memory search`, `/memory status`, `/memory gc`, `/tasks`, `/schedules`, `/schedule run`, `/schedule toggle`, `/session list/new/view`, `/agents`, `/tools`, `/channel`, `/artifacts`, `/config`, `/audit`, `/soul`, `/edit`, `/clear`, `/verbose`, `/compact`, `/export`, `/help`, `/quit`) | Slash commands | Useful | Lift the subset that maps to v1 features only (`/agents`, `/threads`, `/tools`, `/memory`, `/audit`, `/config`, `/help`, `/quit`). |
| Slash command palette overlay (filterable list triggered by `/`) | Slash commands | Useful | Lift pattern. |
| Onboarding wizard (first-run, agent name + emoji, creates `~/.claw/` workspace) | Onboarding | Useful | Hive equivalent: set up Root Agent identity + workspace dir. |
| Profile discovery via conversation (user's name/role/team learned over time, not asked upfront) | Onboarding | Useful | Strong UX; lift as Personal-origin Capability behavior. |
| BYOK / custom provider config (OpenAI-compatible, Azure OpenAI, Anthropic, Ollama via `baseUrl`/`apiKey`/`bearerToken`) | Provider / BYOK | Core | Hive must not lock to a single provider; lift first-class. |
| Provider type field with default `openai` | Provider / BYOK | Core | Pairs. |
| Bundled GitHub Copilot SDK auth (via `gh` CLI, zero custom auth) | Provider / BYOK | Skip | Specific to Copilot SDK; Hive is provider-agnostic. |
| `clientName` in SDK sessions for User-Agent identification | Provider / BYOK | Useful | Whatever provider lib we use, set this. |
| Session resume on daemon restart (SDK session IDs persisted to JSON, conversation context rebuilt from history with budget management + XML escaping) | Daemon / infra | Core | Maps to Thread persistence + Run resume in Hive; foundational. |
| `buildConversationContext()` budget-aware message selection with MOST-RECENT marker | Daemon / infra | Useful | Reuse the algorithm shape. |
| Per-session promise-chain serialization of concurrent `sendMessage` calls (with 5min safety timeout) | Daemon / infra | Useful | Lift for Thread-level serialization. |
| Channel history injection on fresh sessions (recent history loaded into context) | Daemon / infra | Useful | Equivalent to Thread warm-start. |
| Sharded channel storage (JSONL daily shards instead of single file) | Daemon / infra | Useful | Scales Thread history writes. |
| Storage maintenance system (log rotation on startup + heartbeat, session pruning >200, channel trim >500 msgs, stale logs >7d, tmp >24h, archives >30d) | Daemon / infra | Useful | Defensive; lift the patterns. |
| Auto-updater (downloads new MSI from GitHub Releases, `msiexec /quiet` upgrade, preserves user data) | Daemon / infra | Skip | MSI-coupled; revisit packaging after kernel. |
| `update.ps1` / `git pull` + rebuild from-source updater | Daemon / infra | Nice-to-have | Convenience; not v1. |
| Update overlay that polls `/health` `deployTime` fingerprint to confirm restart | Daemon / infra | Nice-to-have | Pairs with updater. |
| Version display with commit SHA, branch name from `.claw-deploy-branch` file | Daemon / infra | Nice-to-have | Polish. |
| Generalization regression test (scan codebase for forbidden personal/team literals) | Daemon / infra | Useful | Lift; aligns with Hive's portability goal. |
| Artifacts: date-organized, YAML frontmatter (title/tags/source/timestamp), auto-tagged by extension, dynamic filtering, detail view, REST API CRUD | Artifacts | Useful | Run-output store; defer past v1. |
| SDK agent artifact auto-save (sub-agents save output as artifact when complete, per-turn dedup) | Artifacts | Useful | Pairs with artifacts. |
| Recursive artifact scanning (scripts in subdirectories appear in Artifacts tab) | Artifacts | Nice-to-have | Polish. |
| Sub-agent checkpoint system (periodic progress checkpoints survive daemon restarts; emergency stop preserves partial results) | Agents | Useful | Reliability win for long Runs. |
| Sub-agent timeout orphan prevention (keepalive signals during active tool execution, idle timeout recovery) | Agents | Useful | Pairs. |
| `onUserPromptSubmitted` hook (inject current time / context into every user prompt) | Agents | Useful | Useful Run-level enrichment hook. |

---

Total: ~150 features triaged.

Quick distribution:
- **Core:** ~25 items (daemon + Web UI + Memory/Capability primitives + Permissions baseline + delegation + BYOK + session resume).
- **Useful:** ~70 items (most heartbeat actions, semantic search, scheduler/triggers, MCP watchdog, trust patterns, audit enrichment, task system if/when it lands).
- **Nice-to-have:** ~20 items (polish — mobile, pins, theme, version display, task swim lanes, etc.).
- **Skip:** ~30 items — dominant reasons: Squad model (replaced by Root Agent + Run-to-Run delegation), CLAW's prose-file memory shape (`SOUL.md`/`USER.md`/`AGENTS.md`/`BOOT.md`/topic graph) conflicts with per-Agent Memory, MSI/`.pkg` installers (premature), Dev Tunnels (vendor lock-in), per-channel tool filtering (Capability binding lives on the Agent Harness in Hive), and Microsoft-specific built-in agents (Workplace-origin, not kernel).
