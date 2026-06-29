# Feature Spec 06 — Tool Registry, Built-in Tools, MCP Config, Docker Sandbox, Artifacts, and Task Orchestration

## 1. Overview

This subsystem is the agent's capability surface and its work-tracking backbone. A **tool registry** discovers which capabilities are available (built-in tools that always exist, CLI-backed tools like `gh`/`docker` that are probed for installation, and MCP servers configured in `tools.json`), tracks per-tool enable/disable overrides and MCP server configurations, and reports the active set of SDK tool names. The orchestrator builds the concrete list of SDK tool objects (via `defineTool`) filtered by that active set, plus a record of MCP server configs passed straight through to the SDK's `mcpServers` session option. Built-in tools include a **structured task store** (`task_manage` + `task_progress`) implementing a full lifecycle state machine with assignment, progress check-ins, dependencies, queue throttling, due-date automation, archival, and a Kanban board summary; an **artifact store** (`save_artifact` + `list_artifacts`) writing date-organized markdown files with YAML frontmatter and extension-based auto-tagging; a **Docker sandbox** (`docker_manage` + `docker_exec`) for container management and isolated multi-language code execution; and wrappers for GitHub (`github_query` via `gh` CLI), schedules, sub-agents, skills, structured memory, and the Agency plugin gallery. A separate **legacy `TASKS.md`** markdown tracker is migrated into the JSON store on every startup and then archived.

All data persists under the data directory `~/.claw/` (`tasks.json`, `task-config.json`, `tools.json`, `artifacts/`, `archive/`, `scripts/`). Tool handlers return human-readable strings (or JSON strings for the gallery); the underlying stores expose richer typed objects to the daemon/REST layer.

---

## 2. Feature Inventory Checklist (every tool)

**Built-in tools (always registered):**
- [ ] `memory_read` — read memory files/search (memory subsystem — owned elsewhere; listed for completeness)
- [ ] `memory_write` — write memory files (owned elsewhere)
- [ ] `manage_memory` — delete memory topics (owned elsewhere)
- [ ] `structured_memory` — people/projects/preferences/facts JSON store (owned elsewhere)
- [ ] `task_manage` — task CRUD + lifecycle + board ✅ (in scope)
- [ ] `task_progress` — progress check-ins ✅ (in scope)
- [ ] `schedule_manage` — scheduled job CRUD ✅ (in scope)
- [ ] `create_custom_agent` — define a reusable custom sub-agent ✅ (in scope, agents tool)
- [ ] `save_artifact` — persist an artifact ✅ (in scope)
- [ ] `list_artifacts` — list/filter artifacts ✅ (in scope)

**Conditionally registered (only if active in registry):**
- [ ] `agency_gallery` — browse/install/publish Agency plugins ✅ (in scope)
- [ ] `github_query` — GitHub via `gh` CLI ✅ (in scope; requires `gh`)
- [ ] `docker_manage` — Docker container/image management ✅ (in scope; requires `docker`)
- [ ] `docker_exec` — sandboxed code execution ✅ (in scope; requires `docker`)
- [ ] `use_skill` — load skill SKILL.md context ✅ (in scope)
- [ ] `execute_skill_script` — run skill scripts via WSL ✅ (in scope)
- [ ] `memory_deep_search` — fallback deep search (owned elsewhere; loaded last)

**Agent tools (registered only when an agentManager is supplied):**
- [ ] `spawn_sub_agent` — spawn one background sub-agent ✅ (in scope, agents tool)
- [ ] `spawn_multi_agents` — spawn several in parallel ✅ (in scope, agents tool)
- [ ] `list_available_agents` — list built-in + custom agents ✅ (in scope, agents tool)
- [ ] `check_active_agents` — list running sub-agents ✅ (in scope, agents tool)

**Per-agent scoped tools (created with an agent name baked in; given to sub-agents):**
- [ ] `skill_write` — write to own skill memory ✅ (in scope)
- [ ] `run_script` — run a prepackaged agent script ✅ (in scope)
- [ ] `read_data` — read a bundled agent data file ✅ (in scope)

**Squad tools (owned by another agent — listed for inventory completeness, NOT specified here):**
- [ ] `squad_route`, `squad_decide`, `squad_memory`, `squad_status`, `squad_skill`

**Registry-`provides` names that are NOT `defineTool` SDK tools** (they are WebSocket protocol message types / UI features, not callable agent tools):
- `channel_search`, `channel_list` — listed under the `channels` built-in registry entry's `provides`, but no `defineTool("channel_search"|"channel_list")` exists in source. Do not implement these as agent tools.

**Legacy markdown task tracker (not an SDK tool — module functions):**
- [ ] `TASKS.md` CRUD: `readTasks`, `addTask`, `updateTaskStatus`, `completeTask` ✅ (in scope)

---

## 3. Detailed Feature Entries

### 3.1 `task_manage`

- **Purpose:** Single action-dispatched tool for the entire structured task lifecycle: create, list, update, complete, assign, queue, cancel, retry, and a board summary.
- **Trigger:** Agent calls it for any task tracking. `skipPermission` is not set, so it follows the default permission policy.
- **Inputs (full param schema):**

  | Param | Type | Req | Default | Notes |
  |---|---|---|---|---|
  | `action` | enum(`create`,`list`,`update`,`complete`,`assign`,`queue`,`cancel`,`retry`,`board`) | yes | — | dispatch |
  | `task_id` | string | cond | — | required for update/complete/assign/queue/cancel/retry |
  | `title` | string | cond | — | required for create |
  | `description` | string | no | `""` | |
  | `priority` | enum(`critical`,`high`,`medium`,`low`) | no | `medium` | |
  | `status` | string | no | — | free-form on update (cast to TaskStatus) |
  | `result` | string | no | `"Completed"` | completion/result summary |
  | `tags` | string[] | no | — | |
  | `context` | string | no | — | rich context for assignee |
  | `role` | string | no | — | agent role (assign); also used as `list` filter |
  | `due_at` | string | no | — | ISO or natural language; `clear`/`none`/`null` clears |
  | `automation_level` | enum(`reminder`,`execute`) | no | `reminder` (when due set) | |
  | `remind_channel` | string | no | — | channel for due reminders |
  | `reschedule` | boolean | no | — | required to re-fire an already-fired due time |
  | `filter_status` | string | no | — | comma-separated statuses for list filter |
  | `channelId` | string | no | — | scope task to a channel |

- **Behavior per action:**
  - **create:** Requires `title`. If `due_at` present and not a clear-word, parses via `parseTaskDueAt` (see §4.2); invalid input returns an error string. Calls `store.create(...)`. Returns: `Created task <id>: "<title>" (<priority>, <status>)` plus optional `in #<channel>` and `due <iso> [<automationLevel>]`.
  - **list:** Builds a filter from `filter_status` (split on `,`), `role`→`assigneeRole`, `channelId`. Returns one line per task: `[<id>] <STATUS> (<priority>) — <title>` plus optional `[#channel]`, `→ <role>`, `⏰ <due> (<level>)`, `[<progress>%]` (only when `progress > 0`). Empty → `No tasks found.`
  - **update:** Requires `task_id`. Copies present fields into an updates object. `due_at` handling: clear-words set `clearDueAt`; otherwise if the task already `firedAt` and `reschedule` is not true → returns the "already fired" error; else parses and sets `dueAt` (+ `rescheduleDue` when `reschedule`). Returns `Updated task <id>: <status>` or `Task not found.`
  - **complete:** Requires `task_id`. Calls `store.complete(task_id, result||"Completed")`. Returns `Completed task <id>: "<title>"` or `Task not found.`
  - **assign:** Requires `task_id` and `role`. Calls `store.assign(task_id, "pending-spawn", role)` (marks task `assigned`; actual agent spawn is a separate `spawn_sub_agent` call). Returns a multi-line block echoing title/description/context/priority and instructing the caller to call `spawn_sub_agent`.
  - **queue:** Requires `task_id`. `store.queue` moves `pending`→`queued` (returns undefined if not pending → tool returns "Task not found or not in pending status…"). Immediately calls `store.drainQueue()`. Returns queue position, `executing/maxConcurrent`, and a capacity note.
  - **cancel:** Requires `task_id`. `store.cancel`. Returns `Cancelled task <id>` or not-found.
  - **retry:** Requires `task_id`. `store.unassign` then `store.update(status:"pending")`. Returns `Task <id> reset to pending for retry.`
  - **board:** Returns three lines — `Lanes: <lane: count | …>`, `Status: <status: count | …>` (both filter out zero counts), `Throttle: <executing>/<maxConcurrent> executing, <queued> queued`.
- **Output-effect:** Mutates `tasks.json` (debounced 1s save via `scheduleSave`, or immediate on some paths). Emits task events to listeners (daemon broadcasts over WebSocket).
- **Edge-cases/errors:** Missing required fields return descriptive strings (never throw). Invalid `due_at` returns `Invalid due_at: <msg>`. Re-firing a fired due time without `reschedule` is blocked.
- **Configuration:** Concurrency from `task-config.json` (`maxConcurrent` default 2). Persistence path `~/.claw/tasks.json`.
- **Dependencies:** `TaskStore` (§4.1), `parseTaskDueAt` (§4.2), `spawn_sub_agent` for actual execution.
- **Example:** `task_manage(action="create", title="Audit PR #42", priority="high", role="researcher", due_at="in 2 hours", automation_level="execute")`.

### 3.2 `task_progress`

- **Purpose:** Sub-agent reports incremental progress on its assigned task; keeps the main agent/user informed and drives lifecycle transitions.
- **Trigger:** Called periodically by a sub-agent. `skipPermission: true` (auto-approved).
- **Inputs:**

  | Param | Type | Req | Validation |
  |---|---|---|---|
  | `task_id` | string | yes | — |
  | `progress` | number | yes | min 0, max 100 |
  | `status` | string | yes | brief status message |
  | `detail` | string | no | longer explanation |
  | `blocked_reason` | string | no | if set, transitions task to `blocked` |

- **Behavior:** Calls `store.checkIn(task_id, progress, status, detail, blocked_reason)`. Appends a `TaskCheckIn` to history, raises `progress` to `max(existing, new)`, updates `lastCheckIn`/`updatedAt`. Then: if `blocked_reason` → status `blocked` (+ `blockedReason`/`blockedSince`); else if `progress >= 100` → status `review`; else if current status was `assigned`/`blocked` → status `in_progress` (clearing blocked metadata when coming from blocked). Records a transition each time.
- **Output-effect:** `Progress recorded: <progress>% — <status>`; or `Task <id> not found.` Emits a `progress` event.
- **Edge-cases:** `progress` never decreases (uses `max`). Reaching 100 routes to `review`, NOT `done` — completion is a separate step.
- **Dependencies:** `TaskStore.checkIn`.
- **Example:** `task_progress(task_id="task-…", progress=100, status="Analysis complete")`.

### 3.3 `schedule_manage`

- **Purpose:** Manage recurring scheduled jobs run headlessly by the daemon scheduler.
- **Trigger:** Agent call (default permission).
- **Inputs:**

  | Param | Type | Req | Notes |
  |---|---|---|---|
  | `action` | enum(`create`,`list`,`delete`,`enable`,`disable`) | yes | |
  | `name` | string | cond | required for create |
  | `description` | string | no | defaults to `objective` |
  | `frequency` | enum(`daily`,`weekly`,`monthly`,`hourly`,`minute`,`once`) | cond | required for create |
  | `time` | string | no | `HH:MM` 24h |
  | `day_of_week` | string | no | `MON…SUN` (weekly) |
  | `day_of_month` | string | no | `1–31` (monthly) |
  | `interval` | number | no | every N units (hourly/minute) |
  | `start_date` | string | no | `YYYY-MM-DD` (once) |
  | `agent_role` | string | cond | required for create; built-in or custom |
  | `objective` | string | cond | required for create |
  | `context` | string | no | |
  | `channel` | string | no | result channel; empty/omit runs silently |
  | `job_id` | string | cond | required for delete/enable/disable |

- **Behavior:** create requires name+frequency+agent_role+objective; builds a `ScheduleSpec` and calls `createScheduledJob(...)`, normalizing channel. list returns formatted job lines (enabled badge, role, schedule, channel, outbound-review warning, last run). delete/enable/disable proxy to `deleteScheduledJob`/`updateJobEnabled`.
- **Output-effect:** Persists scheduled jobs in the scheduler store (separate subsystem). Returns formatted strings.
- **Edge-cases:** Missing required create fields → `Required for create: name, frequency, agent_role, objective.` create wraps errors as `❌ Failed to create scheduled job: <msg>`.
- **Dependencies:** scheduler `manager.js` (`createScheduledJob`, `listScheduledJobs`, `deleteScheduledJob`, `updateJobEnabled`, `normalizeChannel`, `ScheduleSpec`).
- **Schedule display formatting:** daily `Daily at HH:MM` (default 09:00); weekly `Weekly on <DOW> at <time>`; monthly `Monthly on day <N> at <time>`; hourly `Every <N> hour(s)`; minute `Every <N> minute(s)` (default 15); once `Once on <date> at <time>`.

### 3.4 `save_artifact`

- **Purpose:** Persist reusable output (report, script, config, analysis) as a date-organized markdown file.
- **Trigger:** Agent call (default permission).
- **Inputs:**

  | Param | Type | Req | Default | Notes |
  |---|---|---|---|---|
  | `title` | string | yes | — | used as filename slug |
  | `content` | string | yes | — | markdown body |
  | `tags` | string[] | no | `[]` | for scripts include `script` + language |
  | `source_type` | enum(`main`,`sub-agent`,`scheduled`,`heartbeat`,`user`) | no | `main` | |

- **Behavior:** A sub-agent wrapper may inject hidden `_agentSource`/`_agentSourceType` for attribution; otherwise `source` defaults to `main` and `sourceType` is validated against the allowed list (falls back to `main`). Calls `saveArtifact(...)` (§4.3).
- **Output-effect:** Writes `~/.claw/artifacts/<YYYY-MM-DD>/<slug>.md` with frontmatter; dedups filename within the day (`<slug>-1.md`, `-2.md`, …). Caches metadata. Returns `📄 Artifact saved: **<title>**` + relative path + byte size.
- **Edge-cases:** Slug derived from title (lowercased, non-alphanumerics → `-`, trimmed, max 80 chars). Invalid `source_type` silently coerced to `main`.
- **Dependencies:** `saveArtifact`, `VALID_SOURCE_TYPES`.

### 3.5 `list_artifacts`

- **Purpose:** Find previously saved artifacts, optionally filtered.
- **Trigger:** Agent call; `skipPermission: true`.
- **Inputs:**

  | Param | Type | Req | Notes |
  |---|---|---|---|
  | `date` | string | no | `YYYY-MM-DD` |
  | `tag` | string | no | exact tag match |
  | `source_type` | string | no | one of `sub-agent`,`main`,`scheduled`,`heartbeat`,`user` |
  | `limit` | number | no | max results (default: all) |

- **Behavior:** Calls `listArtifacts({date, tag, sourceType, limit})` (§4.3). Returns one block per artifact: `📄 **<title>**` + `Source: <source> (<sourceType>) | <YYYY-MM-DD>` + `Tags: …` + `Path: \`<relativePath>\``. Empty → `No artifacts found.`
- **Output-effect:** Read-only.
- **Dependencies:** `listArtifacts`.

### 3.6 `docker_manage`

- **Purpose:** Low-level Docker container/image management.
- **Trigger:** Registered only if the `docker` CLI tool is active. Default permission.
- **Inputs:**

  | Param | Type | Req | Notes |
  |---|---|---|---|
  | `action` | enum(`ps`,`images`,`run`,`exec`,`logs`,`stop`,`rm`,`pull`,`build`,`inspect`) | yes | |
  | `image` | string | cond | run/pull/build |
  | `container` | string | cond | exec/logs/stop/rm/inspect |
  | `command` | string | cond | run/exec — split on spaces |
  | `args` | string[] | no | extra docker args (run) |
  | `name` | string | no | container name (run) |
  | `ports` | string | no | `host:container` |
  | `volumes` | string[] | no | `host:container` mounts |
  | `workdir` | string | no | `-w` |
  | `env` | string[] | no | `KEY=VALUE` |
  | `detach` | boolean | no | background; removes `--rm`, adds `-d` |
  | `dockerfile` | string | no | build context/path |
  | `tag` | string | no | build tag |

- **Behavior:** Each action shells out to `docker` via a guarded helper. `run` always injects `--rm` (unless detached) plus resource limits `--memory=512m --cpus=2`. `ps` is `ps -a` with a table format; `images` table format; `logs` tails 100; `rm` is forced (`-f`); `inspect` outputs `{{json .}}`.
- **Output-effect:** Returns command stdout+stderr (truncated at 10 000 chars). Containers run with `--rm` and memory/cpu caps.
- **Edge-cases / safety:** The helper **blocks** these flags entirely: `--privileged`, `--net=host`, `--pid=host`, `--userns=host`, `--cap-add`, `--cap-drop`, `--security-opt`, `--device`, `--ipc=host`, `--uts=host`, `--cgroup-parent`. It blocks volume mounts whose host path is `/`, `C:\`, or `C:`. Missing required params return `Error: <param> required for <action>`. Any error returns `Docker error: <msg>`. Operation timeout 120 000 ms, `maxBuffer` 1 MB.
- **Dependencies:** `docker` CLI.

### 3.7 `docker_exec`

- **Purpose:** Run a code snippet in a sandboxed, network-isolated container, auto-selecting the base image by language.
- **Trigger:** Registered only if `docker` active. Default permission.
- **Inputs:**

  | Param | Type | Req | Notes |
  |---|---|---|---|
  | `language` | enum(`python`,`node`,`bash`,`sh`,`ruby`) | yes | |
  | `code` | string | yes | passed as the interpreter's inline-eval arg |
  | `volumes` | string[] | no | mounts |
  | `env` | string[] | no | `KEY=VALUE` |
  | `image` | string | no | override base image |

- **Language → image / command mapping:**
  - `python` → `python:3-slim`, `python -c <code>`
  - `node` → `node:22-slim`, `node -e <code>`
  - `bash` → `alpine:latest`, `sh -c <code>`
  - `sh` → `alpine:latest`, `sh -c <code>`
  - `ruby` → `ruby:3-slim`, `ruby -e <code>`
  - (a `go` entry → `golang:1.23-alpine` exists in the map but `go` is NOT in the `language` enum, so it is not selectable through this tool)
- **Isolation model:** every run is `docker run --rm --memory=512m --cpus=2 --network=none <image> <cmd> <code>`. No network. Auto-removed on exit. Same blocked-flag / root-mount safety as `docker_manage`.
- **Output-effect:** Returns combined stdout, with stderr appended under a `STDERR:` heading if present; empty → `(no output)`. Truncated at 10 000 chars. Errors → `Docker exec error: <msg>`.
- **Dependencies:** `docker` CLI.
- **Example:** `docker_exec(language="python", code="print(2**10)")` → `1024`.

### 3.8 `github_query`

- **Purpose:** Query GitHub PRs, issues, commits, and code search through the authenticated `gh` CLI.
- **Trigger:** Registered only if `gh` active. `skipPermission: false` (always requires permission — it can read/write via the authenticated CLI).
- **Inputs:**

  | Param | Type | Req | Notes |
  |---|---|---|---|
  | `action` | enum(`list_prs`,`get_pr`,`pr_diff`,`list_issues`,`get_issue`,`list_commits`,`search_code`,`repo_info`) | yes | |
  | `repo` | string | no | `owner/repo` |
  | `number` | string | no | PR/issue number (default `"1"`) |
  | `state` | string | no | `open`/`closed`/`all` (default `open`) |
  | `query` | string | no | search query (search_code) |
  | `limit` | string | no | max results (default 20; list_commits 10; search 10) |

- **Behavior / `gh` invocations:**
  - `list_prs` → `gh pr list --repo … --state … --limit … --json number,title,author,createdAt,url,labels,reviewDecision`
  - `get_pr` → `gh pr view <n> --repo … --json number,title,body,author,createdAt,files,reviews,comments`
  - `pr_diff` → `gh pr diff <n> --repo …`
  - `list_issues` → `gh issue list --repo … --state … --limit … --json number,title,author,createdAt,url,labels`
  - `get_issue` → `gh issue view <n> --repo … --json number,title,body,author,comments`
  - `list_commits` → `gh api /repos/<repo>/commits --jq '.[0:<limit>] | …{sha,message,author,date}'`
  - `search_code` → `gh search code <query> --repo … --limit … --json path,repository,textMatches`
  - `repo_info` → `gh repo view <repo> --json name,description,defaultBranchRef,languages,pushedAt,url`
- **Output-effect:** On success returns the `gh` stdout (or `(no data)`); on failure `GitHub query failed: <stderr|message>`. Timeout 30 000 ms.
- **Dependencies:** `gh` CLI installed and authenticated.

### 3.9 `create_custom_agent`

- **Purpose:** Persist a reusable custom sub-agent definition (and optional skill knowledge) so it appears in the agent list and can be spawned by name.
- **Inputs:** `name` (string, kebab-case, req), `description` (string, req), `emoji` (string, opt, default `🤖`), `model` (string, opt override), `system_prompt` (string, req), `skill_knowledge` (string, opt — saved as `domain-knowledge.md` in the agent's skills dir).
- **Behavior:** Saves the agent def via `saveCustomAgentDef`; if `skill_knowledge` given, ensures the skills dir and writes the file; appends a note to the daily memory log. Returns a confirmation listing description/model/skill-knowledge path and the `spawn_sub_agent(role="<name>")` usage.
- **Dependencies:** custom-agents store, skill-memory writer, memory daily log.

### 3.10 `spawn_sub_agent`

- **Purpose:** Launch one specialist sub-agent in the background; non-blocking.
- **Inputs:** `role` (string, req — built-in: `researcher`,`developer`,`qa`,`writer`,`architect`,`security_analyst`, or a custom agent name), `objective` (string, req), `context` (string, opt), `complexity` (enum `low`|`high`, opt).
- **Behavior:** If `complexity==="high"` returns a confirmation-required block and does NOT spawn (caller must re-call with `low` after user confirmation). Otherwise pre-flight checks `agentManager.canSpawn()` (concurrency/budget); rejection returns `⚠️ <reason>`. Captures the current channel id, fires `agentManager.spawn(role, objective, context)` fire-and-forget, and on completion appends a cleaned (≤500 char) summary to the daily log. Returns a "🚀 Spawned" acknowledgement immediately.
- **Output-effect:** Background sub-agent; results stream to chat and daily log.
- **Dependencies:** `SubAgentManager`.

### 3.11 `spawn_multi_agents`

- **Purpose:** Spawn several sub-agents in parallel.
- **Inputs:** `agents` — array of `{ role: string (req), objective: string (req), context?: string }`.
- **Behavior:** Pre-flight `canSpawn()`; rejection returns `⚠️ <reason>`. Iterates, re-checking capacity each iteration (skipped agents are listed as `SKIPPED — <reason>`), spawns fire-and-forget with the same daily-log summary on completion. Returns a launched/skipped list.
- **Dependencies:** `SubAgentManager`.

### 3.12 `list_available_agents`

- **Purpose:** List all built-in + custom sub-agents before spawning. `skipPermission: true`.
- **Inputs:** none (`z.object({})`).
- **Behavior:** `agentManager.listAvailableAgents()`. Returns `<emoji> **<role>** [custom|built-in]` + description per agent; empty → `No agents available.`

### 3.13 `check_active_agents`

- **Purpose:** Report currently running sub-agents and how long each has run. `skipPermission: true`.
- **Inputs:** none.
- **Behavior:** `agentManager.getActiveAgents()`. Returns `<emoji> **<label>** — running for <N>s` per agent; empty → `No sub-agents currently running. All quiet.`

### 3.14 `agency_gallery`

- **Purpose:** Conversational access to the Agency Plugin Gallery (browse/search/inspect/install/publish skills, MCPs, agents from a local marketplace catalog). Registered only if `agency_gallery` registry tool is active.
- **Inputs:**

  | Param | Type | Notes |
  |---|---|---|
  | `action` | enum(`search`,`detail`,`consent`,`install`,`uninstall`,`installed`,`status`,`refresh`,`diagnose`,`setup`,`publish`) | required |
  | `query` | string ≤400 | search |
  | `id` | string ≤200 | detail/consent/install |
  | `spec` | string ≤200 | uninstall (falls back to `id`) |
  | `consentToMcp` | boolean | required true to install executable MCPs |
  | `setupAction` | enum(`setRoot`,`clone`,`redetect`) | setup sub-action |
  | `root` | string ≤500 | setup setRoot |
  | `repoUrl` | string ≤500 | setup clone |
  | `dest` | string ≤500 | setup clone destination |
  | `filters` | object `{skills?,mcp?,agents?,compatibleOnly?,category?}` | search filters |
  | `limit` | int 1–100 | |
  | `publish` | object `{name,description,category?,engines?,keywords?,executableMcp?,files?}` | publish input |

- **Behavior:** Dispatches to an `AgencyGalleryService` façade. `install` requires `consentToMcp:true` for executable MCP servers. `publish` is a governance-gated dry-run (defaults `dryRun:true`) returning the PR it *would* open — never opens a live PR. Most actions return pretty-printed JSON strings.
- **Edge-cases:** Missing required ids/specs throw with descriptive messages (e.g. `id is required for action=detail`).
- **Dependencies:** Agency service, config (`agency.catalog_root` / `catalog_repo_url` / `catalog_marketplace` default `playground`).

### 3.15 `use_skill`

- **Purpose:** Load full SKILL.md context for a domain skill (xlsx/docx/pdf/pptx etc.) on demand. Registered in async tool loading.
- **Inputs:** `action` enum(`load`,`list`,`detect`) req; `name` string (load); `text` string (detect).
- **Behavior:** `list` enumerates registered skills (from `vendor/`, `skills/`, `~/.claw/skills/`) with description/file/scripts dir. `detect` returns skills relevant to a text description. `load` returns the trimmed SKILL.md content with a header and scripts dir path; unknown name lists available skills.
- **Dependencies:** skill registry.

### 3.16 `execute_skill_script`

- **Purpose:** Run a skill's bundled script inside WSL (Linux), with automatic Windows→`/mnt/...` path conversion.
- **Inputs:** `action` enum(`run`,`list_scripts`,`check_deps`,`install_deps`) req; `skill_name` string req; `script` string (relative path in the skill's `scripts/`, run); `args` string[] (passed as positional `$@` — never interpolated, preventing shell injection); `confirmation` string (must be `"yes"` for install_deps).
- **Behavior:** `run` validates the relative path (no `..`, not absolute), confirms existence, asserts symlink-confinement, picks interpreter by extension (`.py`→`python3` after `source ~/.venv/bin/activate`, `.sh`→`bash`, `.js`→`node`), and executes via `wsl -e bash -c '<template>' <scriptName> <args...>`. `list_scripts` lists `.py/.sh/.js` recursively. `check_deps`/`install_deps` parse `requirements.txt` (skill-local + shared) and check/install via pip in the WSL venv.
- **Edge-cases:** Unknown skill lists available skills. Unsupported extension errors. WSL absent → install-WSL guidance. Output truncated at 20 000 chars; timeout 120 000 ms.
- **Dependencies:** WSL, skill registry, Python venv at `~/.venv`.

### 3.17 `skill_write` (per-agent scoped)

- **Purpose:** Let a sub-agent write to its own skill-memory directory. The agent name is baked in at tool-creation time, confining writes to that agent.
- **Inputs:** `file` string (e.g. `config.md`), `content` string.
- **Behavior:** `writeSkillFile(agentName, file, content)`. Returns `✅ Saved to skill memory: ~/.claw/skills/<agent>/<file>`.

### 3.18 `run_script` (per-agent scoped)

- **Purpose:** Run a prepackaged executable script bundled in the agent's `scripts/` dir.
- **Inputs:** `script` string (name without extension), `args` `Record<string,string>` (named params), `cwd` string (working-dir override).
- **Behavior:** Resolves the script by name across recognized extensions and maps to an interpreter: `.ps1`→`pwsh`, `.py`→`python`, `.js`→`node`, `.sh`→`bash`. Arg conventions per interpreter: pwsh `-key value`; python `--kebab-key value`; node `--key=value`; bash receives args as `AGENT_<SNAKE_KEY>` env vars (prefixed to avoid clobbering system vars). Heavy path-confinement: scripts dir must not be a symlink; resolved script path confined via `realpath`+`relative`; `cwd` must be within the runtime dir, data dir, or the agent's skills dir, and may not be a symlink.
- **Output-effect:** Returns JSON `{stdout, stderr, exitCode}`. Timeout 300 000 ms, `maxBuffer` 5 MB, `windowsHide`.
- **Edge-cases:** Missing script lists available script names. Path traversal → `Path traversal blocked`. Invalid cwd / out-of-workspace cwd errors.

### 3.19 `read_data` (per-agent scoped)

- **Purpose:** Read a static reference data file bundled in the agent's `data/` dir.
- **Inputs:** `path` string (relative to `data/`).
- **Behavior:** Strict path-confinement checked BEFORE any filesystem access (relative-path check first to avoid leaking existence), rejects symlinks and non-files, re-checks confinement against real paths. Max file size 1 048 576 bytes (1 MB).
- **Output-effect:** Returns file contents as UTF-8. Errors: `Path traversal blocked`, `Data file not found`, `File too large: <size> (max 1.0 MB)`, etc.

### 3.20 `memory_deep_search`

- **Purpose:** Fallback deep search across memory/topics, daily logs, artifacts, and sessions when the fast keyword index is thin. `skipPermission: true`. (Memory subsystem — owned by another agent; listed for inventory.)
- **Inputs:** `query` string req; `top_k` number opt (default 12, clamped 1–50).

### 3.21 Legacy `TASKS.md` tracker (module functions, NOT an SDK tool)

- **Purpose:** The older flat-markdown task list, kept for migration only. File at `~/.claw/TASKS.md`.
- **Functions / behavior:**
  - `readTasks()` → returns the raw file contents, or `No tasks file found.`
  - `addTask(description)` → creates the file with three sections if absent (`## In Progress`, `## Pending Review`, `## Completed`, each seeded `(none)`), inserts `- [task-<id>] <description>` under In Progress, returns `Added task [<id>]: <description>`. Ids are `task-<monotonic-ms>`.
  - `updateTaskStatus(taskId, status)` where status ∈ `in_progress|pending_review|completed` → finds the `- [id] desc` line, moves it to the target section, restores `(none)` to emptied sections, returns `Task <id> moved to <status>.`
  - `completeTask(taskId)` → `updateTaskStatus(taskId, "completed")`.
- **Relationship to the JSON store:** `TaskStore.load()` runs `migrateFromMarkdown()` on every startup: it parses `TASKS.md` (three formats — checkbox `- [ ]`/`- [x]`, `- [task-123]`, and plain bullets ≥10 chars), creates equivalent JSON tasks (dedup by lowercased title), then archives the markdown file to `~/.claw/archive/TASKS.md.migrated-<ts>` and deletes the original (only after a successful archive write). This is one-directional: markdown → JSON.

### 3.22 Tool Registry

- **Purpose:** Discover and track which capabilities exist; report the active SDK-tool name set; persist enable/disable overrides and MCP server configs to `~/.claw/tools.json`.
- **Categories:** `built-in` (always `active`, cannot be disabled), `cli` (probed for installation), `mcp` (configured servers; SDK manages connection state).
- **Built-in registry entries** (`name` → `provides` SDK tool names): `memory`→[`memory_read`,`memory_write`]; `tasks`→[`task_manage`]; `schedules`→[`schedule_manage`]; `agents`→[`spawn_sub_agent`,`spawn_multi_agents`,`list_available_agents`,`create_custom_agent`]; `channels`→[`channel_search`,`channel_list`] (no actual defineTool — see §2); `skills`→[`use_skill`,`execute_skill_script`]; `agency_gallery`→[`agency_gallery`].
- **CLI registry entries:** `github` (checkCommand `gh`, checkArgs `--version`, provides [`github_query`]); `docker` (checkCommand `docker`, checkArgs `--version`, provides [`docker_manage`,`docker_exec`]).
- **Availability detection:** `checkToolAvailability` runs `execFile(checkCommand, checkArgs, {timeout:5000, windowsHide})`. On success, extracts a version via regex `(\d+\.\d+[\.\d]*)`, sets status to `active` (if enabled) or `disabled`; on failure sets status `missing` and records the error. `checkAllAvailability()` re-runs this for every `cli` tool in parallel (the re-scan path, e.g. `POST /api/tools/scan`).
- **Enable/disable:** `setEnabled(name, enabled)` — built-ins cannot be toggled (returns false); for CLI tools it flips `enabled`, re-checks availability when re-enabling, sets status `disabled` when disabling, then `saveConfig()`. Disabled non-default states are persisted in `overrides`.
- **Active set:** `getActiveToolNames()` returns the union of `provides` for every tool whose `status === "active"`. The orchestrator passes this set to `getAllToolsAsync(agentManager, activeToolNames)`, which only includes a `defineTool` object when its name is in the set (built-in task/artifact/memory/schedule/agent tools are always pushed; `agency_gallery`, `github_query`, `docker_manage`, `docker_exec` are gated on activeness).
- **MCP tracking:** On `initialize()`, configured `mcp_servers` are registered as `mcp`-category tools (status `active`, `provides:[]` — the SDK discovers tools at session creation). A server whose `name` collides with a reserved built-in/CLI name is skipped. Names starting with `mcp-` trigger a warning (legacy bug; not auto-renamed). `addMcpServer` rejects reserved-name collisions and saves; `removeMcpServer` deletes an `mcp` tool and saves.
- **Re-init behavior:** `initialize()` is idempotent via an in-flight promise; `_doInitialize()` clears the tools map and reserved names first so removed config entries don't survive as ghosts. One-time migration copies a legacy `tools.json` from the runtime dir to the data dir.
- **How MCP reaches the SDK:** `buildMcpServersConfig()` reads the registry (must be initialized, else returns empty + `configError`), and for each enabled `mcp` tool builds a `Record<name, MCPServerConfig>`: stdio → `{type:"stdio", command, args:[], env, tools:["*"]}`; http → `{type:"http", url, tools:["*"]}`. The orchestrator merges in the Agency MCP proxy, then passes the record to `client.createSession({ … mcpServers })` only when non-empty. `extractCleanupPatterns()` derives command-line substrings for Windows orphan-process cleanup after disconnect.

### 3.23 Artifact store (module — backs §3.4 / §3.5 and REST)

- **Purpose:** Persist agent outputs as browsable, date-organized files. Layout `~/.claw/artifacts/<YYYY-MM-DD>/<slug>.md`.
- **save/list/read/delete/update:** see §4.3 for behavior and the frontmatter schema. Auto-tagging by extension applies to non-`.md` files and scripts. List can also surface root-level artifact files and (recursively) the `~/.claw/scripts/` dir as `script`-tagged artifacts.

---

## 4. Data & Formats Appendix

### 4.1 Task object schema (`Task`)

Persisted as a JSON array in `~/.claw/tasks.json`. Every field:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `task-<epochMs>-<4 base36 chars>` |
| `title` | string | required at create |
| `description` | string | default `""` |
| `status` | TaskStatus | see §4.4 |
| `priority` | `critical`\|`high`\|`medium`\|`low` | default `medium` |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | |
| `channelId` | string? | undefined ⇒ "general" |
| `assignee` | string? | sub-agent id (or `pending-spawn` placeholder) |
| `assigneeRole` | string? | agent role |
| `assignedAt` | ISO? | |
| `progress` | number | 0–100; monotonic non-decreasing on check-in |
| `lastCheckIn` | ISO? | |
| `checkIns` | TaskCheckIn[] | `{timestamp, progress, status, detail?}` — full history preserved |
| `completedAt` | ISO? | set on done/failed/cancelled |
| `result` | string? | completion/failure summary |
| `artifactIds` | string[]? | linked artifacts |
| `skipReview` | boolean? | if true allows active → done directly |
| `blockedReason` | string? | required while blocked |
| `blockedSince` | ISO? | for escalation |
| `archivedAt` | ISO? | set when archived |
| `recurrence` | string? | cron expr |
| `isTemplate` | boolean? | templates excluded from board |
| `dependsOn` | string[]? | prerequisite task ids |
| `parentTaskId` | string? | |
| `tags` | string[]? | |
| `context` | string? | rich context for assignee |
| `sessionIds` | string[]? | CLAW sessions worked on it |
| `linkedPrIds` | string[]? | GitHub PR refs |
| `completionReport` | string? | channel-display summary built on complete/fail |
| `sessionId` | string? | primary executing session |
| `executionDurationMs` | number? | |
| `queuedAt` | ISO? | when entered the queue |
| `dueAt` | ISO? | due time |
| `automationLevel` | `reminder`\|`execute` | defaults to `reminder` when `dueAt` set |
| `remindChannelId` | string? | due reminder channel |
| `firedAt` | ISO? | due time fired |
| `reminderState` | `pending`\|`delivered`\|`dismissed`? | |
| `reminderDeliveredAt` | ISO? | |
| `fallbackReason` | string? | why execute fell back to reminder |
| `comments` | TaskComment[]? | `{id,author,body,createdAt}` |
| `transitions` | TaskTransition[]? | `{id,fromStatus,toStatus,movedBy,reason?,timestamp}` |

**Board lane mapping** (`getLane`): `pending`→backlog; `queued`→queued; `assigned`/`in_progress`→active; `blocked`→blocked; `review`→review; `done`/`failed`/`cancelled`→done.

### 4.2 Due-date parsing (`parseTaskDueAt`)

Accepts, in order: (1) anything `new Date()` parses (ISO etc.) → emitted as ISO with local offset; (2) `in <N> minutes|hours`; (3) `tomorrow [at] <clock>`; (4) `tonight [at] <clock>` (rolls to next day if already past). `<clock>` is `H`, `H:MM`, with optional `am`/`pm`. Empty input throws; unrecognized input throws with the supported-formats message. `automationLevel` defaults to `reminder` when a due time is present.

### 4.3 Artifact storage & frontmatter

- **Path:** `~/.claw/artifacts/<YYYY-MM-DD>/<slug>.md`. Slug = title lowercased, non-alphanumerics→`-`, trimmed, ≤80 chars. Filename dedup within a day appends `-1`, `-2`, …
- **`ArtifactMeta`:** `{ id (==relativePath), title, source, sourceType, tags[], createdAt (ISO), relativePath (e.g. "2026-02-21/foo.md"), sizeBytes, versionCount? }`. `Artifact` extends it with `content`.
- **YAML frontmatter written:**
  ```
  ---
  title: <title>
  source: <source>
  source_type: <sourceType>
  tags: [<comma-joined tags>]
  created_at: <ISO>
  ---
  ```
  Parser reads `title`, `source`, `source_type`, `tags` (strips `[ ]`, splits on `,`), `created_at`. Missing frontmatter ⇒ defaults: title from filename, `source:"unknown"`, `sourceType:"main"`, `createdAt` from mtime.
- **`source_type` allowed values (`VALID_SOURCE_TYPES`):** `main`, `sub-agent`, `scheduled`, `heartbeat`, `user`.
- **Auto-tagging by extension (non-`.md` files & scripts):** py→[python,script]; ps1→[powershell,script]; sh→[shell,script]; bat/cmd→[batch,script]; js→[javascript,script]; ts→[typescript,script]; pptx/ppt→[presentation]; xlsx→[spreadsheet]; csv→[data]; json→[data]; html→[web]; png/jpg/jpeg/gif/svg→[image]; pdf→[document]. Scripts dir entries are additionally prefixed with `script`.
- **list filters:** `date` (single `YYYY-MM-DD` dir), `tag` (exact membership), `sourceType` (exact), `limit`. Results sorted newest-first by `createdAt`. Scripts dir only scanned when no `date` filter.
- **read:** `.md` parses frontmatter; binary types (pptx,ppt,xlsx,xls,docx,pdf,png,jpg,jpeg,gif,zip) return metadata-only placeholder content; other text returned verbatim. Path-traversal-guarded.
- **delete/update:** path-confined within artifacts dir (or scripts dir for `scripts/…` ids); update preserves existing frontmatter for `.md`.
- **queryArtifacts (richer REST query):** supports `date`/`startDate`/`endDate` range, `tag`, `source`, `sourceType`, `search`, `groupRecurring`, `offset`, `limit` (default 50); returns `{ items, total, tags: Record<tag,count> }`; recurring artifacts (same sourceType|source|normalized-title) collapse to the newest with a `versionCount`.

### 4.4 Task lifecycle state machine

**States:** `pending`, `queued`, `assigned`, `in_progress`, `blocked`, `review`, `done`, `failed`, `cancelled`. Terminal: `done`, `failed`, `cancelled`.

**Transitions and triggers:**

| From | To | Trigger / method |
|---|---|---|
| (create) | `pending` | `create()` — always starts pending |
| `pending` | `queued` | `queue()` (manual approval) or `fireExecuteDue()` (due automation, execute level) |
| `queued` | `assigned` | `drainQueue()` when capacity available (sets assignee `pending-spawn`); or explicit `assign()` |
| `pending` | `assigned` | `assign(agentId, role)` directly (also via `task_manage assign`) |
| `assigned` | `in_progress` | first `checkIn()` with progress < 100 and no block |
| `blocked` | `in_progress` | `checkIn()` without `blockedReason` (clears blocked metadata) |
| `assigned`/`in_progress`/any | `blocked` | `checkIn()` with `blocked_reason` (records `blockedReason`+`blockedSince`) |
| `in_progress`/`assigned` | `review` | `checkIn()` with progress ≥ 100 |
| any | `done` | `complete()` (sets progress 100, builds completionReport) |
| any | `failed` | `fail(reason)` (builds failure report) |
| any | `cancelled` | `cancel()` / `delete()` (archive) |
| terminal/any | `pending` | `unassign()` / `task_manage retry` (clears assignee) — re-entry for reassignment |

- **`moveTask(id, toStatus, movedBy, reason?)`** is the generic transition: `blocked` requires a reason (returns undefined otherwise); moving to terminal stamps `completedAt` (and `progress=100` for done); moving to `pending` clears assignment. All transitions are appended to `task.transitions`.
- **Assignment to roles:** `assigneeRole` holds the role (`researcher`,`developer`,`qa`,`writer`,`architect`,`security_analyst`, or custom). `task_manage assign` sets assignee to the `pending-spawn` placeholder and instructs a separate `spawn_sub_agent` call; the queue drainer also uses `pending-spawn` until the caller spawns the real agent. `recoverPendingSpawnOrphans()` on startup resets stuck `assigned`/`pending-spawn` tasks back to `queued`.
- **Auto-close on sub-agent completion/failure:** the sub-agent lifecycle calls `complete()`/`fail()` on the linked task (documented in README "Auto-close"); `complete()`/`fail()` each schedule a 500 ms-delayed `drainQueue()` so a freed slot starts the next queued task.
- **Progress check-ins:** `checkIn()` appends to `checkIns[]` (history preserved), raises `progress` monotonically, updates `lastCheckIn`. `getStale(maxMinutes=30)` finds active tasks with no recent activity (heartbeat flips them to blocked).
- **Dependencies & readiness:** `getReady()` returns `pending` tasks whose every `dependsOn` id is `done`.
- **Board summary (`getBoardSummary`):** `{ byStatus: Record<status,count>, byLane: Record<lane,count> }`, excluding archived tasks and templates. `task_manage board` renders both plus throttle.

### 4.5 Queue throttle config (`task-config.json`)

| Field | Default | Clamp |
|---|---|---|
| `maxConcurrent` | 2 | 1–10 |
| `queueDrainIntervalMs` | 60000 | ≥10000 |
| `maxExecuteCatchupAge` | 43200000 (12h) | ≥0 |
| `archiveAfterDays` | 14 | ≥0 |
| `maxHotTasks` | 500 | ≥1 |
| `hardDeleteAfterDays` | 0 (disabled) | ≥0 |

Queue ordering: priority (critical→low), then FIFO by `queuedAt`, then id. `getExecutingCount()` counts `assigned`+`in_progress`. `hasCapacity()` = executing < `maxConcurrent`. A periodic drain timer (`runDueRetentionAndDrain`) processes due tasks, runs retention maintenance, and drains the queue.

### 4.6 Archive / retention

Terminal tasks older than `archiveAfterDays` get `archivedAt` set (`autoArchive`). `runRetentionMaintenance` (≥24h apart unless forced) archives by age and evicts terminal tasks beyond `maxHotTasks` to cold JSONL shards `~/.claw/archive/tasks-<YYYY>-<MM>.jsonl` (with tombstone records on unarchive). `delete()` archives (status→cancelled) rather than hard-deleting; `hardDelete()` is programmatic-only.

### 4.7 Due-date automation (`processDueTasks`)

For each due candidate (≤ cap, default 50): `reminder`-level tasks are batched per channel and delivered via the reminder notifier (marked `delivered`). `execute`-level tasks: skipped if already executing; if `blocked`/`review` they fall back to a reminder; require a non-empty `assigneeRole` (else reminder fallback); skipped if overdue beyond `maxExecuteCatchupAge` (reminder fallback); otherwise `fireExecuteDue` queues them. Batched delivery (`>3` per channel or `batchCatchup`) sends a single "N task reminders came due while offline" message.

### 4.8 `tools.json` schema

```json
{
  "overrides": { "<toolName>": { "enabled": false } },
  "mcp_servers": [
    {
      "name": "my-server",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "VALUE" },
      "url": "https://…",
      "discoveredTools": ["…"]
    }
  ]
}
```

- **`overrides`:** only CLI tools that are explicitly disabled are written (`{ enabled: false }`); built-in and active-default tools are omitted. On load, `override.enabled ?? true`.
- **`mcp_servers[]` (`McpServerConfig` + `name`):** `name` (string, must not collide with reserved built-in/CLI names); `transport` `"stdio"`|`"http"`; for stdio: `command` (string), `args` (string[]), `env` (`Record<string,string>`); for http: `url` (string); `discoveredTools` (string[], populated by the SDK at session creation). Servers are passed to the SDK as `mcpServers: { <name>: {type, command/url, args, env, tools:["*"]} }`.

### 4.9 REST endpoints (index — verify against router at HEAD)

Tasks: `GET /api/tasks` (legacy TASKS.md read via `GET/PUT`) and `GET /api/tasks` list (filters `?status=,?role=,?tag=,?priority=`); `POST /api/tasks` create; `GET /api/tasks/:id` detail (with check-in history); `PUT /api/tasks/:id` update; `DELETE /api/tasks/:id`; `POST /api/tasks/:id/assign`; `/cancel`; `/complete`; `/retry`; `GET /api/tasks/board` (counts per status). Tools: `GET /api/tools`; `POST /api/tools/:name/toggle`; `POST /api/tools/scan`; `POST /api/tools/mcp`; `DELETE /api/tools/mcp/:name`. Artifacts: `GET /api/artifacts` (filters `?date=,?tag=,?source_type=`); `GET /api/artifacts/:id`; `DELETE /api/artifacts/:id`.

---

## 5. Coverage Notes

- **Verified against source at HEAD** (`main`, commit 6a1b89a2): `tools.ts` (every `defineTool`), `tool-registry.ts`, `tools/docker.ts`, `tools/use-skill.ts`, `tools/execute-skill-script.ts`, `tools/agency-gallery.ts`, `artifacts.ts`, `task-store.ts`, `task-due.ts`, `github.ts`, `tasks/tracker.ts`, `mcp-config.ts`, `paths.ts`, and the orchestrator's `createSession` wiring (`tools`, `mcpServers`).
- **Complete `defineTool` inventory** confirmed by grepping `defineTool(` across `src/`: 19 in `tools.ts`, 2 in `docker.ts`, plus `use_skill`, `execute_skill_script`, `agency_gallery`, `memory_deep_search`, and the 5 `squad_*` (out of scope). No other SDK tools exist.
- **`channel_search` / `channel_list`:** these appear ONLY as registry `provides` strings and as WebSocket protocol message types — there is no `defineTool` for them. A re-implementer should NOT expose them as agent-callable tools (documented in §2 and §3.22).
- **`docker_exec` `go`:** the language→image map contains a `go` entry, but `go` is absent from the tool's `language` enum, so it is unreachable. README claims "Python, Node, Bash, Ruby" — `sh` is also accepted by the enum.
- **Out of scope (owned by other agents) — listed by name only:** memory tools (`memory_read`, `memory_write`, `manage_memory`, `structured_memory`, `memory_deep_search`) and squad tools (`squad_route`, `squad_decide`, `squad_memory`, `squad_status`, `squad_skill`). Their parameter schemas are intentionally not fully specified here.
- **Scheduler internals** (`createScheduledJob` etc.) are a separate subsystem; `schedule_manage` is documented at the tool boundary only.
- **Sub-agent execution / `SubAgentManager`** internals (budget, concurrency, spawn mechanics) are referenced where they affect tool behavior but are a separate subsystem; only the tool-facing contract is specified.
- **The `getAllTools` (sync) variant** contains a known no-op branch for Docker (it cannot load Docker tools synchronously); the live path is `getAllToolsAsync`, which is what the orchestrator uses. The sync variant is a backward-compat fallback only.
- **Permission defaults:** `task_progress`, `list_artifacts`, `list_available_agents`, `check_active_agents`, `memory_read`, `memory_deep_search` set `skipPermission: true`; `github_query` and `manage_memory` explicitly require permission; all others follow the default policy.
