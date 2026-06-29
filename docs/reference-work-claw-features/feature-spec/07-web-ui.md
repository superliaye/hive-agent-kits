# Web UI — Functional Specification

## Overview

The Web UI is a self-contained single-page application served by the daemon at `http://localhost:3117` (one large `index.html` with all CSS/JS inlined — no runtime build step on the client). It is a chat-first agent workspace: a left **sidebar** (collapsible/accordion: Channels, Views, Settings) navigates between ~18 named views, a top **header** shows the current view title / active channel / connection status / theme toggle / events bell / stream-dock toggle, and a central **content** area shows exactly one view at a time. The app maintains a persistent **WebSocket** to `ws(s)://<host>` for real-time chat streaming, agent/tool/sub-agent events, task/squad/terminal updates, and live status; all non-realtime data is read/written through a REST API under `/api/*` (helper `API(path,opts)` = `fetch('/api'+path,{credentials:'include',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}})`). A re-implementation must reproduce: the navigation model and hash routing, the streaming-markdown chat with reply/attach/STT/stop, the collapsible events panel, the raw stream log (tab + dock), and the management views (Agents, Skills, Sessions, Schedules, Memory, Tasks, Settings, Permissions, Tools, Artifacts, Pins, Usage, Squad Dashboard/Settings, Plugin Gallery, Agency Terminal, World, Channel Manager).

---

## Feature Inventory Checklist

Navigation & shell
- [ ] Sidebar with 3 accordion sections: **Channels**, **Views**, **Settings**
- [ ] Channel list (dynamic) with add-channel (+) and sort-mode button (manager / recent / name)
- [ ] Views nav items: Agents, Skills, Tasks, Schedules, Plugins (gallery), Tools, Memory, Pins, Artifacts, Sessions, Channel Manager, Usage, Agency, World (hidden until enabled)
- [ ] Settings nav items: Preferences, Permissions, Help
- [ ] Top header: view title, channel display + model badge, comm status, theme toggle (light/dark), connection dot+text, events bell (+badge), stream-dock toggle, squad header toggle
- [ ] Mobile menu button + slide-in drawer + overlay; per-view mobile slide-in detail panels
- [ ] Hash routing (`#chat`, `#chat/<channelId>`, `#<view>`); back/forward via history
- [ ] Nav-loading overlay during route/channel switch
- [ ] Loading splash on boot (🦀); removed once connected
- [ ] `user_input_request` modal (agent asks user); generic confirm modal; toast notifications

Chat view
- [ ] Streaming markdown assistant messages with live render + code highlight
- [ ] Message timestamps + duration; user/assistant/sub-agent/system/reminder message types
- [ ] Reply-to (reply bar, swipe-right on mobile)
- [ ] Image paste / drag-drop / file attach (preview tray)
- [ ] Send button; Queue button (when busy); Stop button (Esc)
- [ ] Mic button / speech-to-text (Alt+S; Chrome/Edge/WebView2 only)
- [ ] Composer tools button; Agent (@) / Skill (/) / command picker with chips
- [ ] Model badge in header (override vs inherited); verbose toggle; collapse-long-messages
- [ ] Per-message actions: reply, copy, pin, speak (assistant), compose
- [ ] Scroll-to-latest indicator; load-earlier banner
- [ ] Reasoning inspector slide-out (Steps / Activity tabs)
- [ ] Reasoning/roster/stream-dock side panels in chat
- [ ] Channel-paused (loop detected) banner + Resume
- [ ] Disconnect overlay; auto-update banners/modals/overlay

Events panel (popover)
- [ ] Collapsible popover from header bell; unread badge; Clear
- [ ] Tool calls (status, args, result, duration), verbose group, sub-agent events, heartbeat ticks, permission rows

Stream view (tab + dock)
- [ ] Raw real-time log with color-coded badges + timestamps
- [ ] Toolbar (shared registry, tab+dock parity): auto-scroll, reasoning-only, show-all-channels, filter dropdown, clear
- [ ] Per-channel isolation; back-to-sessions when viewing a running agent

Management views
- [ ] Agents (source filter, list/detail, new/edit/delete custom, override built-in, spawn, community sources, active sub-agents bar with cancel)
- [ ] Skills (source filter, refresh, SKILL.md viewer, use-in-channel, publish)
- [ ] Sessions (Running Now / History tabs, search, filter, detail, emergency stop)
- [ ] Schedules (new job/trigger, frequency fields, enable/disable, run-for-review, view review, delete)
- [ ] Memory (List / Graph / Audit modes, hero search + quick-filter chips, file editor + limits)
- [ ] Tasks (status+channel filters, board summary chips, grouped cards w/ progress+priority+assignee, detail pane w/ check-ins+actions, bulk bar, throttle settings)
- [ ] Settings (General/Assistant/Channels&Notifications/Memory&Sources/System tabs, save bar)
- [ ] Permissions (autonomy dial, Rules/Trust/Agent-Profiles/Audit tabs)
- [ ] Tools (tool list w/ toggles, re-scan, MCP server list + add form)
- [ ] Artifacts (date range, search, tag+source filters, day nav, list+detail w/ copy/edit/delete)
- [ ] Pins (folder sidebar + pin cards, create/rename/delete folder, move/unpin)
- [ ] Usage (period selector, summary cards, by-channel/by-model/by-date charts, recent table)
- [ ] Squad Dashboard (roster cards, task metrics, decisions, activity timeline) + Squad Settings (in channel modal)
- [ ] Plugin Gallery (browse/search, install/update/uninstall, setup wizard, publish)
- [ ] Agency Terminal (xterm tabs, new-session form, persistent tmux reconnect)
- [ ] World (16-bit canvas visualizer; keyboard controls; enabled via Settings toggle)
- [ ] Channel Manager (groups board, drag-reorder, hide/unhide, edit)

---

## View-by-view detail

> Routing convention: each view's DOM element is `#v-<name>` and only one is shown at a time. `route(name)` sets the visible view, updates the `#view-title` header, toggles chat-only header controls, expands the sidebar accordion section containing the target, pushes a `#<name>` history entry, and shows the nav-loading overlay until data settles. Sidebar nav items carry `data-view="<name>"`; channel items carry `data-channel="<id>"` and route to chat after `switchToChannel(id)`.

### 1. Chat (`#v-chat`, view `chat`)

**Purpose.** Primary conversation surface with the agent for the active channel: send messages, watch streaming markdown replies, manage attachments/replies, and monitor sub-agent/tool activity.

**Entry-point.** Default view on load. Reached by clicking a channel in the sidebar (also switches channel) or `route('chat')`. Channel deep-link via `#chat/<channelId>`.

**Displayed data.** Message list (`#messages`) replayed from WS `connected`/`channel_switched` history; each message rendered by role:
- **User** — "You" label, timestamp, optional reply-quote, escaped text, attachment thumbnails, agent/skill picker receipt chips, optional "queued" badge.
- **Assistant** — agent emoji+name (from config), timestamp + duration, markdown-rendered HTML (live while streaming), action buttons. Long assistant/sub-agent messages (>400px) collapse with Show more/less when the preference is on (latest stays expanded while streaming).
- **Sub-agent** — role emoji+name, markdown body.
- **System** — icon + event text (visible only when verbose is on; preserved in DOM otherwise).
- **Reminder card** — task reminder (⏰), title, description, dismiss/reply actions.

Header shows channel emoji+name and a **model badge** (`🧠 <model> · <effort>`, "override" emphasized vs "inherited" muted; hidden if no info). A typing/“agent working” dock shows while busy.

**Controls and actions.**
| Control | Action | Backing call |
|---|---|---|
| Message textarea `#msg-in` | Type message; `@`→agent picker, `/`→command/skill picker | — |
| Send `#send-btn` | Send message when idle | WS `send_message {channelId,content,attachments?,replyTo?,requestedAgents?,requestedSkills?}` |
| Queue `#queue-btn` (when busy) | Queue/inject while agent busy | WS `inject_context` (or message queued → `message_queued`) |
| Stop `#stop-btn` (Esc) | Cancel current agent turn | WS `cancel` |
| Mic `#mic-btn` (Alt+S) | Toggle speech-to-text | Browser `SpeechRecognition`/`webkitSpeechRecognition` (no endpoint) |
| Attach `#attach-btn` / paste / drag-drop | Stage image/file attachment | — (sent inline as base64 in `send_message`) |
| Composer tools `#composer-tools-btn` | Toggle composer extras (picker) | — |
| Reply (per message) | Set reply context → reply bar; X cancels | reply data sent with next `send_message` |
| Copy (per message) | Copy raw text to clipboard | — |
| Pin (per message) | Pin → choose folder | `POST /api/pins` |
| Speak (assistant) | Read aloud / stop | Browser `speechSynthesis` |
| Compose (assistant) | Open compose-reply modal | — |
| Scroll indicator `#scroll-indicator` | Jump to latest | — |
| Load-earlier banner | Page older history | WS `load_more {before,limit}` |
| Reasoning inspector (Steps/Activity tabs) | Show captured reasoning/tool steps | — |
| Resume polling (paused banner) | Resume a loop-paused channel | (channel resume action) |
| Cancel sub-agent (active bar / event) | Stop a specific sub-agent | WS `cancel_agent {agentId}` |
| Sub-agent checkpoint Continue/Stop | Answer a checkpoint | WS `sub_agent_checkpoint_response {agentId,action}` |

Also calls at various points: `GET /api/models` (model list), `GET /api/agents/types`, `GET /api/audio-synthesis/status`, `GET /api/pins/folders`, `GET /api/artifacts/:id/content` (audio playback), `GET /health` (disconnect/update polling), and channel CRUD via the channel modal (`POST/PUT/DELETE /api/channels[/:id]`, `POST/DELETE /api/channels/:id/squad[/init]`).

**Interactions & shortcuts.** Enter = send (idle) / inject (busy); Shift+Enter = newline; Esc = stop agent / close modal / close reasoning panel; Alt+S = mic toggle; Ctrl/Cmd+Enter = send in compose modal; ↑/↓ at input edges = command history; right-click assistant message = context menu (copy/reply/pin/compose/info); swipe-right (mobile) = reply.

**Real-time updates (WS received).** `auth_ok`→`connect`+`list_channels`; `connected` (history, busy, hasMore/offset → renders, sets status “Connected”, removes splash); `history_chunk` (paginated older history); `user_message`; `thinking` (typing indicator); `chunk` (streamed tokens, live markdown ~throttled, `_raw` kept); `complete` (finalize, highlight code, collapse); `cancelled`; `error`; `message_queued`/`queue_update` (queue badges); `injecting`; `system_message` (reminder card or event); `sub_agent_status`; `sub_agent_checkpoint`; `sub_agent_spawned`/`sub_agent_complete` (active bar + events); `user_input_request` (modal); `verbose`/`tool_call` (events panel + stream); `channel_busy`/`channel_idle`; `channel_list`/`channel_created`/`channel_archived`; `channel_switched` (reset+replay); `cross_channel_activity` (unread badge, toast); `emergency_stop`/`daemon_restart`; auto-update set: `update_available`/`update_confirm`/`update_starting`/`update_countdown`/`update_applying`/`update_complete`; `permission_request`/`permission_decision`; delegated `task_*`, `squad_*`, `pty_*`. Keepalive: client sends `ping` (~15s) + `presence`; receives `pong`.

**Edge cases.** Disconnect → status “Reconnecting…”, send button queues (messages held locally, flushed on reconnect), full-screen overlay after prolonged loss with eventual Reload; if a new `deployTime` is detected on reconnect the page reloads. Safe-mode banner shown when started on a fallback model. Per-channel drafts saved/restored on switch. Attachments serialized base64; "(see attached)" used when no text.

**Example flow.** User types "summarize today's logs", presses Enter → WS `send_message` → header dot stays green, typing dock appears (`thinking`) → assistant bubble fills token-by-token (`chunk`) with live markdown → a `tool_call` for memory read appears in the events popover → `complete` finalizes the message with a timestamp+duration; user clicks Pin → chooses a folder → `POST /api/pins`.

---

### 2. Events Panel (header popover)

**Purpose.** Keep the chat clean by routing tool calls, sub-agent events, verbose reasoning, permission decisions, and heartbeat ticks into a collapsible side popover.

**Entry-point.** `#events-bell` button in the header (chat view only); `toggleEventsPopover()` opens `#events-popover`. A red badge `#events-bell-badge` shows unread event count.

**Displayed data.** Scrollable list (`#events-list`) of rows: **Tool call** (color-coded badge, tool name, status RUNNING/DONE, expandable args/result, duration, time); **Verbose group** ("Agent activity", collapsible nested log); **Sub-agent** spawned/completed (role, agentId, duration, success); **Permission** request/decision (ASK/ALLOW/DENY badges, tool, risk); **Heartbeat tick** ("Heartbeat #N: …"); **System** (cancellation/error). A full-turn details modal can show all tool calls + verbose events for a completed turn.

**Controls and actions.** Bell (open/close); **Clear** (`clearEvents()`) resets the list; click a tool row to expand inline or open the turn modal; click verbose group to expand/collapse.

**Interactions & shortcuts.** Esc closes the turn modal; clicking outside closes the popover.

**Real-time updates.** Populated from WS `tool_call`, `verbose`, `sub_agent_spawned`/`sub_agent_complete`, `permission_request`/`permission_decision`, `system_message`. Badge increments per event; cleared on new turn or by Clear.

**Edge cases.** Verbose log capped (~200 entries / ~4000 chars); events reset at turn/channel boundaries.

**Example flow.** Agent runs three tools → bell badge shows "3" → user opens popover, expands the second tool to read its JSON args/result, clicks the turn header to see the whole turn tree, then Clear.

---

### 3. Stream (`#v-stream`, view `stream`; plus docked `#stream-dock`)

**Purpose.** Raw, real-time, color-coded log of all agent activity (chunks, reasoning, tool calls, verbose, permissions) with filtering and auto-scroll. Available full-screen (tab) and as a chat-side dock with identical controls.

**Entry-point.** Stream-dock toggle `#stream-dock-btn` in header opens the dock (desktop) or routes to the full stream view (mobile). Clicking a running agent in Sessions opens the stream for that session (with a "← Sessions" back row).

**Displayed data.** Each line: `[HH:MM:SS.mmm] [BADGE] text detail`. Badges are color-coded by category: CHUNK (model tokens), AGENT/thinking (reasoning), TOOL (tool calls), VERBOSE, PERM/ALLOW/DENY, plus lifecycle events. Token deltas coalesce into one accumulating line. Status row `#stream-status` shows a dot + Idle/Live.

**Controls and actions (shared `STREAM_CONTROLS` registry; rendered to both tab and dock toolbars).**
| Control | Action |
|---|---|
| Auto-scroll checkbox | Keep newest line in view (on by default) |
| Reasoning-only checkbox | Show only reasoning lines; disables the filter dropdown (persisted) |
| Show-all-streams checkbox | Include events from every channel (else only active channel) |
| Filter dropdown | All events / Tools only / Verbose only / Agent activity / Chunks only |
| Clear button | Empty the log |
| Close (dock) `×` / `#stream-close` (mobile) | Close dock / return to chat |
| `#stream-back` | Return to Sessions when viewing a session stream |

The dock is resizable (drag handle, width persisted; double-click resets).

**Interactions & shortcuts.** No dedicated keys; toolbar parity keeps tab and dock state in sync.

**Real-time updates.** Lines appended from the same WS messages that feed chat/events; buffered while hidden and flushed on show. On `channel_switched`, the filter re-evaluates against the new active channel.

**Edge cases.** Max retained lines pruned (oldest dropped); long accumulated detail trimmed to a sliding window for display.

**Example flow.** User opens the dock while the agent works → watches CHUNK lines stream and a TOOL line appear → ticks "Reasoning only" to focus on the model's thinking → clicks Clear before the next turn.

---

### 4. Agents (`#v-agents`, view `agents`)

**Purpose.** Browse built-in/custom/plugin/community agent types with rich profiles, edit/create definitions, spawn an agent into a channel, and manage community sources. An active sub-agents bar lets you cancel running agents.

**Entry-point.** Views accordion → Agents.

**Displayed data.** Left list of agent cards (emoji, name, badges: 🦀 built-in / ⚙️ customized / 👤 custom / 🧩 plugin / 🌐 community / 📜 scripts / 📁 data; description). Right detail pane: description, personality, goal, strengths, tools; custom agents show editable name(readonly)/emoji/model/description/tools/system-prompt + scripts/data sections; built-ins show an Edit→override form. A spawn section (channel dropdown + Spawn) appears for all types. Active sub-agents bar: chips with emoji + role + elapsed time + stop.

**Controls and actions.**
| Control | Action | Endpoint |
|---|---|---|
| Source filter (All/Built-in/Custom/Plugin) | Filter list | — |
| Refresh | Reload types | `GET /api/agents/types` |
| + New Agent | Start a new custom agent | (form) → `POST /api/agents/custom` |
| Save Changes (custom) | Persist custom agent | `PUT /api/agents/custom/:name` |
| Delete (custom, confirm) | Remove custom agent | `DELETE /api/agents/custom/:name` |
| View Full Prompt | Show system prompt modal | — |
| Publish | Publish to community catalog | publish modal → `/api/agency/publish/*` |
| Save Override (built-in) | Override a built-in | `PUT /api/agents/builtin/:name` |
| Reset to Defaults | Remove override | `DELETE /api/agents/builtin/:name/override` |
| Spawn | Preselect agent in chosen channel's composer (does not send) | — |
| Community: load/sources/sync | Browse, add/remove git sources, sync, enable/disable | `GET /api/agents/community`, `GET/POST/DELETE /api/agents/community/sources`, `POST /api/agents/community/enable\|disable\|sync` |
| Active bar Stop (⏹) | Cancel a running sub-agent | `POST /api/agents/active/:id/cancel` |
| (model dropdown) | Populate model choices | `GET /api/models` |

**Interactions & shortcuts.** None special; confirmations for delete/disable/reset. Active agents polled `GET /api/agents/active` (~3s).

**Real-time updates.** Active sub-agents reflected via polling; chat-side WS `sub_agent_spawned`/`complete` also update the active bar.

**Edge cases.** Empty/no-match states; orchestrator-only agents hidden; community-add shows a security warning.

**Example flow.** Filter to Custom → select "doc-writer" → edit its system prompt → Save Changes (`PUT /api/agents/custom/doc-writer`) → choose channel "docs" → Spawn (preselects it in that composer).

---

### 5. Skills (`#v-skills`, view `skills`)

**Purpose.** Browse native/local/plugin skills, read each SKILL.md, and preselect a skill into a channel composer; publish local skills.

**Entry-point.** Views accordion → Skills.

**Displayed data.** Left list of skill cards (emoji, name, source badge 📦/👤/🧩, 📄 if ships scripts). Right detail: source line, description, full SKILL.md in a monospace block, a "Use this skill" section (channel dropdown + Use), and Publish for user-local skills.

**Controls and actions.**
| Control | Action | Endpoint |
|---|---|---|
| Source filter (All/Native/Local/Plugin) | Filter list | — |
| Refresh | Reload + clear cache | `POST /api/skills/refresh` then `GET /api/skills` |
| Select skill | Load SKILL.md (cached) | `GET /api/skills/:name` |
| Use skill | Preselect in chosen channel's composer | — |
| Publish (user skills) | Publish to catalog | publish modal |

**Interactions & shortcuts.** None special. **Real-time:** none (static). **Edge cases:** loading/empty/error toasts; content HTML-escaped.

**Example flow.** Filter to Local → select "redact-pdf" → read SKILL.md → choose channel "ops" → Use skill.

---

### 6. Sessions (`#v-sessions`, view `sessions`)

**Purpose.** See currently running agents and browse historical sub-agent/scheduled transcripts.

**Entry-point.** Views accordion → Sessions. Two tabs: **🔴 Running Now** / **History**.

**Displayed data.** Running Now: cards with emoji + role + "Running Xs/Ym" + Stop; clicking opens the stream for that session. History: searchable/filterable list of session cards (status ✓/✕/⚫ Live, title from role+objective, start time, message count); detail pane shows role/objective/timestamps/status/duration + message transcript (assistant markdown; others escaped).

**Controls and actions.**
| Control | Action | Endpoint |
|---|---|---|
| Tab switch | Running vs History | — |
| Running card click | Open session stream | (switches stream channel) |
| Stop (⏹, confirm) | Cancel running agent | `POST /api/agents/active/:id/cancel` |
| Stop Everything & Restart (confirm) | Emergency stop all + restart daemon | `POST /api/emergency-stop` |
| Search `#sess-search` | Filter history by title | — (client filter) |
| Filter dropdown | Filter by type (sub-agent/scheduled/heartbeat/main) | `GET /api/sessions` |
| Session card | Load full transcript | `GET /api/sessions/:id` |
| Refresh | Reload list | `GET /api/sessions` |

Running Now polls `GET /api/agents/active` (~3s while visible).

**Interactions & shortcuts.** Enter/Space activates a focused running card. **Real-time:** running list via polling; live agent output via the stream WS channel. **Edge cases:** empty states; emergency-stop and per-agent stop confirmations.

**Example flow.** Running Now shows 2 agents → click one → stream view opens with its live log → "← Sessions" returns → History tab → search "research" → open a finished transcript.

---

### 7. Schedules (`#v-schedules`, view `schedules`)

**Purpose.** Create/edit scheduled jobs and triggers, enable/disable them, run once for review, view the review, and delete.

**Entry-point.** Views accordion → Schedules. "＋ New Schedule".

**Displayed data.** Left list of schedule cards (⚡ trigger or job icon, name, role · schedule string · review status, last-run summary, description). Right detail = the create/edit form + action buttons + review status.

**Form fields.** Type (Scheduled Job / ⚡ Trigger); Name; Description; **Job:** Frequency (daily/weekly/hourly/minute/once/monthly), Time (HH:MM), Day-of-Week, Day-of-Month, Interval, Skip weekends; **Trigger:** Command, Check interval (s, ≥5), Timeout (ms); Agent Role; Channel; Objective/Message-template.

**Controls and actions.**
| Control | Action | Endpoint |
|---|---|---|
| Create / Update | Save schedule | `POST /api/schedules` / `PUT /api/schedules/:id` |
| Enable/Disable toggle | Flip enabled | `PUT /api/schedules/:id {enabled}` |
| ▶ Run once for review | Start a review run, then poll | `POST /api/schedules/:id/review-run` |
| View review | Open review report modal (summary, data accessed, changes, risk, recommendation) | — (from schedule data) |
| 🗑 Delete (confirm) | Remove | `DELETE /api/schedules/:id` |
| Role dropdown | Populated from agent types | `GET /api/agents/types` |
| (list load) | Fetch schedules | `GET /api/schedules` |

**Interactions & shortcuts.** Frequency dropdown shows/hides relevant time fields. Review enable flow gates unattended runs behind an "I reviewed this" confirmation.

**Real-time updates.** None (review state polled `GET /api/schedules` ~3s after a review-run). **Edge cases:** trigger interval ≥5s; 429 rate-limit shows last-good list and retries after `Retry-After`; empty state prompts to create one.

**Example flow.** New Schedule → Job, daily, 09:00, role researcher, channel general, objective "summarize inbox" → Create → Run once for review → View review → "enable unattended runs".

---

### 8. Memory (`#v-memory`, view `memory`)

**Purpose.** Browse and edit memory (SOUL/USER/MEMORY, topics, structured data, daily logs), full-text/semantic search, view a topic graph, and read the memory operations audit log.

**Entry-point.** Views accordion → Memory. Three modes via toolbar: **☰ List**, **◎ Graph**, **📋 Audit**.

**Displayed data.**
- **List:** file tree grouped into Core files (with size/limit progress), Memory topics (🏷), Structured data (🧩), Daily logs (🗓, newest first, "Show all"); right pane = file editor.
- **Graph:** Cytoscape topic graph; node color by category (People `#5865f2`, Projects `#3ba55d`, Security `#e8832a`, Personal `#9c59b6`, Other `#6b7280`), size by fact count; click a node → detail panel (summary, fact count, category, full content).
- **Audit:** paginated operations log (fact added/skipped/merged/deleted, gc, manage run) with icons + timestamps + "Load older".

**Controls and actions.**
| Control | Action | Endpoint |
|---|---|---|
| Hero search `#mem-search` (Enter) | Keyword/semantic search; Esc clears | `GET /api/memory/search?q=` (or `/search/v2?q=&source_type=`) |
| Quick-filter chips (All/Topics/Daily/Structured/Core) | Re-run search scoped | — |
| ☰/◎/📋 toggle | Switch List/Graph/Audit | Graph: `GET /api/memory/graph`; Audit: `GET /api/memory/files/audit?limit=&offset=` |
| File tree item | Load file (readonly) | `GET /api/memory/:file` |
| Edit toggle | Make editor editable | — |
| Save | Persist file | `PUT /api/memory/:file {content}` |
| Limit KB input | Change core file max size | `PUT /api/memory-limits` |
| (status) | Semantic search status | `GET /api/memory/semantic-status` |

Search results render grouped by source with score badges, snippets (highlighted terms), and "Open file →".

**Interactions & shortcuts.** Enter = search, Esc = clear (in search box); graph search highlights matching nodes. **Real-time:** none (REST/poll). **Edge cases:** semantic-degraded falls back to keyword (badge shows 🧠 Semantic vs 🔤 Keyword); empty results state.

**Example flow.** Type "Henry promotion" + Enter → semantic results grouped by daily/topic → click a daily-log result → opens List mode with that file in the editor → Edit → fix a line → Save.

---

### 9. Tasks (`#v-tasks`, view `tasks`)

**Purpose.** Structured task board grouped by status with progress, priority, assignee, and a detail pane offering lifecycle actions.

**Entry-point.** Views accordion → Tasks.

**Displayed data.** Sticky toolbar: status filter (All/Active/Backlog/Queued/Executing/Done/Failed), channel filter, throttle info (`⚡ executing/max · queued`), board-summary chips (per-status counts), + New Task. Task list grouped by status lanes with select-all per actionable group. Card: left-border status color, checkbox, title, priority badge (hidden for medium), channel badge, due-date badge (overdue red, ⚙️ auto-run, ✓ reminded), assignee (🤖), last check-in time, description snippet, progress bar. Detail pane (`#task-detail-pane`): status, priority, channel, due info, description, assignee, progress, result, blocked reason, traceability (sessions/artifacts/PRs), collapsible check-ins + history, action buttons.

**Controls and actions.**
| Control | Action | Endpoint |
|---|---|---|
| Status filter / Channel filter | Re-query list | `GET /api/tasks?status=&channelId=` |
| Board summary | Counts per status | `GET /api/tasks/board` |
| Throttle gear | Edit max concurrent | `GET /api/tasks/config`; (save) |
| + New Task | Create form (title/desc/channel/agent/due/automation) | `POST /api/tasks` |
| Open card | Load detail | `GET /api/tasks/:id` |
| ▶ Start | Queue a pending task | `POST /api/tasks/:id/queue` |
| ✅ Complete | Mark done | `POST /api/tasks/:id/complete` |
| 🔄 Retry | Retry failed | `POST /api/tasks/:id/retry` |
| Cancel | Cancel non-terminal | `POST /api/tasks/:id/cancel` |
| Assign | Assign to a role | `POST /api/tasks/:id/assign {role}` |
| ✏️ Edit / Save | Update fields | `PUT /api/tasks/:id` |
| 🗑 Delete (confirm) | Archive | `DELETE /api/tasks/:id` |
| Bulk bar | Start/Retry/Complete/Archive selected | same endpoints per id |

(Channels for filters: `GET /api/channels`; agents for assignment: `GET /api/agents/types`.)

**Interactions & shortcuts.** Multi-select via checkboxes shows the bulk bar. **Real-time:** WS `task_created`/`task_updated`/`task_completed`/`task_failed`/`task_queued`/`task_execution_started` trigger a board refresh (only when the Tasks view is visible); `task_progress` updates the progress bar in place. **Edge cases:** overdue styling; archived-channel tasks keep their channel label.

**Example flow.** Filter Active → open a running task → read its last 3 check-ins → progress jumps to 100% via `task_progress` → ✅ Complete (`POST /api/tasks/:id/complete`).

---

### 10. Settings / Preferences (`#v-settings`, view `settings`)

**Purpose.** Configure identity, appearance, model/reasoning, escalation, communication channels, notifications, memory sources, and system/infrastructure.

**Entry-point.** Settings accordion → Preferences. Five category tabs: **General, Assistant, Channels & Notifications, Memory & Sources, System**. A sticky **save bar** ("✓ All changes saved" / "⚠ Unsaved changes", Discard / Save All Changes) governs tracked fields; some cards are tagged **Instant** or **Action** (apply immediately, not via save bar).

**Displayed data & controls.**
- **General:** Identity (name `#s-name`, emoji picker `#emoji-picker`); Appearance (theme presets, contrast slider 0–4, text size, density, accent — all instant, persisted to localStorage; live preview); Features (Enable 16-bit World — instant); About.
- **Assistant:** Model `#s-model` (from `GET /api/models`), Reasoning Effort (Default/Low/Medium/High/Extra High), Escalation Policy (ask/attempt × default/high/low), Heartbeat note (always on, every 15 min), Long-messages collapse toggle (instant), Audio Briefings (`GET /api/audio-synthesis/status`, enable → delegated setup).
- **Channels & Notifications:** Email/Teams toggles + setup (activation mode, trigger phrases, progress/ack), Transport Health panel, Recent Activity panel, Completion Notifications (email/Teams destinations, smart summary, deep link, away-only, snippet).
- **Memory & Sources:** Knowledge Base path; Connected Sources list + enable/disable + Scan.
- **System:** Remote Access (dev tunnel install/login/enable/disable + URL), Daemon (restart), Data Directory (browse/validate/migrate), Updates (auto-check toggle, status, check now).

**Backing endpoints.** `GET/PUT /api/config` (+ `PUT /api/config/update-pipeline`), `GET /api/models`, `GET /api/health`; updates: `GET /api/update/branches|status`, `POST /api/update/check|apply`; tunnel: `GET /api/tunnel/status`, `POST /api/tunnel/install-cli|login|enable|disable`; daemon: `POST /api/restart`; data dir: `GET /api/data-dir`, `POST /api/browse-folder|validate-path|migrate-data`; sources: `GET /api/memory/sources`, `POST /api/memory/sources/scan`, `POST /api/memory/sources/:id/status`; comm: `GET /api/comm-channels/prerequisites|status|health|incidents`, `POST /api/comm-channels/toggle|resume`; completion: `GET /api/completion-notifications/status`; audio: `GET /api/audio-synthesis/status`.

**Top-bar theme toggle.** A light/dark segmented control `#topbar-theme` in the header toggles theme globally from any view; "Match system" (set in Appearance) resolves to OS preference. Persisted in `claw-theme` / `claw-appearance` localStorage.

**Interactions & shortcuts.** Tracked fields mark the form dirty → enables Save/Discard; instant/action cards bypass the save bar. **Real-time:** none core (polling for restart/tunnel/migration progress). **Edge cases:** data-dir/tunnel/browse disabled over remote access; restart polls `GET /api/health` until back; migration shows a progress bar.

**Example flow.** Assistant tab → change Model and Reasoning to High → save bar shows "Unsaved changes" → Save All Changes (`PUT /api/config`) → toast confirms.

---

### 11. Permissions (`#v-permissions`, view `permissions`)

**Purpose.** Tune autonomy and review/approve the agent's tool permissions, trust patterns, per-agent profiles, and audit log.

**Entry-point.** Settings accordion → Permissions.

**Displayed data.** Autonomy dial (0–4: Strict/Supervised/Balanced/Autonomous/YOLO) with a live policy table (categories × levels). Four tabs (with counts): **Rules & Policies**, **Trust Patterns**, **Agent Profiles**, **Audit Log**. Trust patterns show approval progress bars and Always-Allow/Revoke. Agent profiles show success/failure, trust score, autonomy override, allowed categories, dry-run. Audit log: filterable entries (risk/decision/category) with detail + mark-as-safe, stats, pagination, bulk "Allow All Similar".

**Controls and actions.**
| Control | Endpoint |
|---|---|
| (load) seed + read | `POST /api/permissions/seed`, `GET /api/permissions` |
| Save autonomy dial | `PUT /api/permissions {autonomyLevel}` |
| Add/Delete rule | `POST /api/permissions/rules`, `DELETE /api/permissions/rules/:id` |
| Accept/Revoke/Delete trust pattern | `POST /api/permissions/trust-patterns/:id/accept\|revoke`, `DELETE …/delete` |
| Update/Reset/Delete agent profile, dry-run | `PUT /api/permissions/agents/:name`, `…/dry-run`, `POST …/reset-trust`, `DELETE …` |
| Audit list/count/stats | `GET /api/permissions/audit`, `…/audit/count`, `…/audit/stats` |

**Interactions & shortcuts.** Audit auto-refresh checkbox (10s). **Real-time:** none core; audit poll opt-in. **Edge cases:** empty states per tab; permission-request toasts originate from chat WS.

**Example flow.** Move dial to Balanced → Save (`PUT /api/permissions`) → Trust Patterns → a pattern is "ready" → Always Allow.

---

### 12. Tools (`#v-tools`, view `tools`)

**Purpose.** Enable/disable agent tools, re-scan availability, and manage MCP servers.

**Entry-point.** Views accordion → Tools.

**Displayed data.** Tool cards (name, enable toggle, description). MCP server cards (name + plugin chip, transport, status badge — 🟢 Connected/🟡 Connecting/🔑 Needs Auth/🔴 Failed/🟠 Degraded/⚪ Disabled, tool count, error row). Add-MCP form (name, transport stdio/http, command/URL).

**Controls and actions.**
| Control | Endpoint |
|---|---|
| (load tools) | `GET /api/tools` |
| Tool toggle | `PUT /api/tools/:name {enabled}` (README lists this as `POST /api/tools/:name/toggle`; the SPA at HEAD uses PUT) |
| Re-scan Tools | `POST /api/tools/scan` |
| (load MCP) | `GET /api/tools/mcp` |
| Add MCP Server | `POST /api/tools/mcp {name,transport,command\|url}` |
| Remove MCP | `DELETE /api/tools/mcp/:name` |

**Interactions & shortcuts.** Transport select swaps the Command/URL label. **Real-time:** none. **Edge cases:** empty tool/MCP states; MCP error text rendered safely; plugin-provided MCPs show attribution.

**Example flow.** Toggle "docker_exec" off → toast confirms → Add MCP: name "kusto", stdio, command `npx -y @kusto/mcp` → Add (`POST /api/tools/mcp`).

---

### 13. Artifacts (`#v-artifacts`, view `artifacts`)

**Purpose.** Browse date-organized files produced by agents, filter by tag/source/date, and view/edit/delete content.

**Entry-point.** Views accordion → Artifacts.

**Displayed data.** Toolbar: range (Today/Yesterday/Last 7 days/Custom/All), active-range label, search, tag-filter chips (All + top tags), start/end date inputs (end shown for custom), source filter, ← Previous day / Today / Next day, Refresh. List of artifact cards (title, tag badges, source · created · version count). Detail: title, meta (source/sourceType/created/tags/relative path), rendered body (markdown / pretty JSON / text).

**Controls and actions.**
| Control | Endpoint |
|---|---|
| Range / dates / source / tag / search | `GET /api/artifacts?date=&start_date=&end_date=&source=&tag=&search=&offset=&limit=` |
| Day nav (prev/today/next) | re-query `GET /api/artifacts` |
| Select artifact | `GET /api/artifacts/:id` |
| Copy | clipboard (no endpoint) |
| 📁 Copy Path | `GET /api/artifacts/:id/path` → clipboard |
| Edit / Save | `PUT /api/artifacts/:id {content}` |
| Delete (confirm) | `DELETE /api/artifacts/:id` |
| Load more | next page via `offset` |

**Interactions & shortcuts.** Search debounced. **Real-time:** none. **Edge cases:** per-range empty states with shortcut buttons (e.g., "View yesterday").

**Example flow.** Range = Last 7 days → tag chip "presentation" → open one → Copy Path → paste into a terminal.

---

### 14. Pins (`#v-pins`, view `pins`)

**Purpose.** Organize pinned chat messages into folders.

**Entry-point.** Views accordion → Pins. (Pins are created from the chat per-message Pin action.)

**Displayed data.** Two columns: folder sidebar (All Pins + count, Uncategorized, custom folders with rename/delete) and pin cards (role badge 👤/🤖, timestamp, content preview ~300 chars, folder dropdown, Unpin).

**Controls and actions.**
| Control | Endpoint |
|---|---|
| Load pins (all/by folder) | `GET /api/pins` / `GET /api/pins?folderId=` |
| Create pin (from chat) | `POST /api/pins` |
| Check pinned | `GET /api/pins/check/:messageId?channelId=` |
| Unpin (confirm) | `DELETE /api/pins/:pinId` |
| Move to folder | `PUT /api/pins/:pinId/move {folderId}` |
| + New Folder | `POST /api/pins/folders` |
| Rename folder | `PUT /api/pins/folders/:id {name}` |
| Delete folder | `DELETE /api/pins/folders/:id` |
| List folders | `GET /api/pins/folders` |

**Interactions & shortcuts.** None special. **Real-time:** none. **Edge cases:** empty state prompts to pin from chat; deleting a folder moves its pins to Uncategorized.

**Example flow.** Pin an assistant message from chat → Pins view → create folder "Decisions" → move the pin into it.

---

### 15. Usage (`#v-usage`, view `usage`)

**Purpose.** Show token/cost usage over a chosen period.

**Entry-point.** Views accordion → Usage.

**Displayed data.** Period selector (Today / 7 / 30 / 90 days / All). Summary cards (Turns, Input Tokens, Output Tokens, Cost-units with disclaimer). Horizontal bar charts by channel and by model. Vertical daily-trend chart. Recent-turns table (Time/Channel/Model/Input/Output/Cost, ~20 rows).

**Controls and actions.**
| Control | Endpoint |
|---|---|
| Period buttons | re-query all below |
| Summary | `GET /api/usage/summary?from=&to=` |
| By channel | `GET /api/usage/by-channel?from=&to=` |
| By model | `GET /api/usage/by-model?from=&to=` |
| By date | `GET /api/usage/by-date?from=&to=&granularity=day` |
| Recent | `GET /api/usage/recent?limit=20` |
| Refresh | re-query |

**Interactions & shortcuts.** Auto-refresh ~30s while visible. **Real-time:** polling only. **Edge cases:** empty state ("No usage data yet").

**Example flow.** Click "30 days" → cost cards and per-model bars update → scan recent-turns table.

---

### 16. Squad Dashboard + Squad Settings

**Purpose.** Turn a channel into a coordinated agent squad: a live dashboard (roster, task metrics, decisions, activity) plus configuration (roster, autonomy, lead, max agents, repo).

**Entry-point.** For squad channels, a header **squad toggle** switches the chat-side **Roster panel** (`#roster-panel` / `#squad-dashboard-content`) Chat ↔ Roster; configuration lives in the **Channel Create/Edit modal** under "⚡ Squad Channel".

**Displayed data.** Roster cards (agent name, role, 👑 lead, live status dot). Task metrics (Pending/Active/Blocked/Done) + live task list (icon, title, status, assignee, time-ago, priority, progress). Recent activity timeline (agent + event + time). Decisions (author + summary). Empty-squad onboarding card with roster + how-it-works steps + "Start a conversation".

**Controls and actions.**
| Control | Endpoint |
|---|---|
| Load dashboard | `GET /api/channels/:id/squad/dashboard` |
| Squad status/config | `GET /api/channels/:id/squad/status` |
| Squadify / Save settings | `POST /api/channels/:id/squad/init {name,roster,autonomyLevel,repo,leadAgent,maxConcurrentAgents}` |
| De-squadify (confirm) | `DELETE /api/channels/:id/squad` |
| Add task (squad modal) | `POST /api/tasks` |
| Roster agent dropdowns | `GET /api/agents/types` |
| Squad task list | `GET /api/tasks?channelId=&status=active` |
| Roster panel collapse | toggle (no endpoint) |

Squad config fields (in channel modal): Squad Name, Autonomy (supervised/semi-autonomous/autonomous), Lead Agent, Max Agents (1–10), Roster (agent + role rows, + Add Agent), optional template picker.

**Interactions & shortcuts.** Squad header toggle switches Chat/Roster; roster sections collapse (persisted). **Real-time:** any WS `squad_*` message reloads dashboard + task list (when an active squad channel is shown); dashboard also auto-refreshes ~30s. **Edge cases:** non-squad channels hide the toggle/panel; empty squad shows onboarding.

**Example flow.** Open channel modal → enable Squad → pick template or add 3 agents with roles → set lead + max 3 → Save (`POST …/squad/init`) → header Roster toggle shows live cards; a `squad_decide` event appears in Decisions.

---

### 17. Plugin Gallery (`#v-agency-gallery`, view `agency-gallery`)

**Purpose.** Browse/search the Agency plugin catalog and install/update/uninstall plugins (skills/MCPs/agents); publish new ones.

**Entry-point.** Views accordion → Plugins.

**Displayed data.** Browse grid of plugin cards (id, description, badges: ✓ Installed / update-available / drift, compatibility, provides chips 🎯 skill / 🔌 mcp / 🤖 agent, category, repo link). A detail drawer with Install/Update/Force-update/Uninstall (MCP consent modal when required). First-run setup wizard (clone catalog or point at an existing clone) and an Agency-CLI install banner. A Publish tab (name, description, category, keywords, executable-MCP flag, content) with validate→scrub→preview→create-PR.

**Controls and actions (endpoints).** `GET /api/agency/gallery/status|setup|installed|install-state`, `GET /api/agency/gallery/search?q=&limit=`, `GET /api/agency/gallery/plugin/:id`; `POST /api/agency/gallery/install|force-update|uninstall|refresh|setup`; `POST /api/agency/install-agency`; publish: `POST /api/agency/gallery/publish` (and submit). Filters: search (debounced), "Installed only", infinite scroll / Load more.

**Interactions & shortcuts.** Shift+Enter re-checks setup/CLI. **Real-time:** poll-based. **Edge cases:** install/uninstall disabled over remote; MCP consent gate; publish blocked by validation findings; governance gate on PRs.

**Example flow.** Search "incident" → open a card → Install (consent to MCP) → it shows ✓ Installed; later a new version → Update.

---

### 18. Agency Terminal (`#v-agency-terminal`, view `agency-terminal`)

**Purpose.** Run the Agency CLI in an embedded xterm.js terminal, with multiple tabs and optional persistent (tmux) sessions.

**Entry-point.** Views accordion → Agency.

**Displayed data.** Tab bar (one tab per PTY: name from cwd, ● persistent / ⏵ reattached, "(exited)" badge, × close), a status row (connection + cwd), the xterm mount, and an empty state. The "+ New" form: working directory (recent-dir chips), Persistent (tmux) checkbox, --yolo checkbox, Extra options, Open/Cancel, plus a reconnect list of existing persistent sessions.

**Controls and actions.** All over WebSocket (no REST):
- Send: `pty_open {ptyId,args,cols,rows,cwd?,persistent?,tmuxSessionId?}`, `pty_input {ptyId,data}`, `pty_resize {ptyId,cols,rows}`, `pty_close {ptyId}`, `pty_kill_persistent {sessionId}`, `pty_list_persistent`.
- Receive: `pty_data` (write to xterm), `pty_exit` (show exit code/signal), `pty_error`, `pty_persistent_list` (refresh reconnect picker + checkbox availability), `pty_persistent_killed`.

**Interactions & shortcuts.** Enter in cwd = Open; Esc = hide form; tab × = detach (Shift/Alt+click = kill tmux). Recent dirs persisted (localStorage). **Real-time:** live terminal I/O via PTY WS. **Edge cases:** persistent disabled over remote / when tmux unavailable; sessions survive view switches and (with tmux) daemon restarts; if xterm not bundled, the view shows an inline error.

**Example flow.** + New → cwd `~/projects/app`, Persistent on → Open → terminal streams; switch away and back → still running; reconnect picker lists it after a refresh.

---

### 19. World (`#v-world`, view `world`)

**Purpose.** Optional 16-bit top-down visualizer of active agents in themed zones.

**Entry-point.** Hidden until enabled in Settings → General → Features → "Enable 16-bit Agent World"; then a World nav item appears. `route('world')` (redirects to chat if disabled).

**Displayed data.** Canvas with a 3×3 grid of role zones (Library/researcher, Workshop/developer, Vault/security, Study/writer, Plans/architect, Lab/qa, Station/custom, Town Square=idle, HQ). Agents are sprites that wander when idle and animate to work spots when active. Legend maps role→color. Header shows build tag + LIVE badge. An inspector panel shows the selected agent's objective, current tool + elapsed, last say, runtime, session/task/channel ids, an activity timeline, and "Jump to stream".

**Controls and actions.** Click / Tab = select; ←↑↓→ = select nearest in direction; Enter = jump to that agent's stream; Esc = close inspector; F = follow-cam; D = debug hit-boxes; ? = help overlay. Data via `GET /api/agents/active` (poll ~3s) + WS `squad_*` ticks.

**Interactions & shortcuts.** See above (canvas must be focused). **Real-time:** poll-driven state with activation flashes; stale marker when an active agent goes >15s without updates. **Edge cases:** custom agents get deterministic looks; non-resident customs auto-exit after ~60s idle.

**Example flow.** Enable World in Settings → open World → press Tab to select a researcher in the Library → Enter to jump to its live stream.

---

### 20. Channel Manager (`#v-channel-manager`, view `channel-manager`)

**Purpose.** Organize channels into collapsible groups, reorder, hide/unhide, and preview per-channel settings.

**Entry-point.** Views accordion → Channel Manager.

**Displayed data.** A board of group cards (collapse toggle, name, channel count, + New Channel) with draggable channel items (emoji, name, description, unread badge, move-to-group, hide toggle, open, edit) and a detail/preview panel.

**Controls and actions.** + Group / Reset layout (layout persisted in localStorage); drag to reorder groups/channels; Hide/Unhide → `PUT /api/channels/:id {hidden}` (general channel cannot be hidden); Open → `switchToChannel(id)` + `route('chat')`; Edit → channel modal (`POST/PUT/DELETE /api/channels[/:id]`, squad config). 

**Interactions & shortcuts.** Drag-and-drop reordering. **Real-time:** channel list reflects WS `channel_created`/`channel_archived`. **Edge cases:** hidden channels removed from the sidebar list; layout reset restores defaults.

**Example flow.** + Group "Backend" → drag two channels into it → collapse the noisy "Personal" group → hide an unused channel.

---

## Data & formats appendix

### View → primary endpoints

| View | REST endpoints | WebSocket |
|---|---|---|
| Chat | `GET /api/models`, `GET /api/agents/types`, `GET /api/audio-synthesis/status`, `GET /api/pins/folders`, `POST /api/pins`, `GET /api/artifacts/:id/content`, `GET /health`, `POST/PUT/DELETE /api/channels[/:id]`, `POST/DELETE /api/channels/:id/squad[/init]` | auth/connect/list_channels/send_message/inject_context/cancel/cancel_agent/load_more/ping/presence/sub_agent_checkpoint_response/update_confirm_response (send); connected/chunk/complete/thinking/tool_call/verbose/system_message/user_message/sub_agent_*/channel_*/update_*/permission_*/error/cancelled (recv) |
| Events panel | (none of its own) | tool_call, verbose, sub_agent_*, permission_*, system_message |
| Stream | (none of its own) | same feed as chat |
| Agents | `GET /api/agents/types`, `GET /api/agents/active`, `POST /api/agents/active/:id/cancel`, `POST/PUT/DELETE /api/agents/custom[/:name]`, `PUT /api/agents/builtin/:name`, `DELETE /api/agents/builtin/:name/override`, `GET /api/agents/community`, `GET/POST/DELETE /api/agents/community/sources`, `POST /api/agents/community/enable|disable|sync`, `GET /api/models` | sub_agent_spawned/complete (active bar) |
| Skills | `GET /api/skills`, `POST /api/skills/refresh`, `GET /api/skills/:name` | — |
| Sessions | `GET /api/agents/active`, `POST /api/agents/active/:id/cancel`, `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/emergency-stop` | (stream via WS when viewing a running agent) |
| Schedules | `GET/POST /api/schedules`, `PUT/DELETE /api/schedules/:id`, `POST /api/schedules/:id/review-run`, `GET /api/agents/types` | — |
| Memory | `GET /api/memory/files`, `GET/PUT /api/memory/:file`, `GET /api/memory/search?q=` (`/search/v2`), `PUT /api/memory-limits`, `GET /api/memory/graph`, `GET /api/memory/files/audit?limit=&offset=`, `GET /api/memory/semantic-status` | — |
| Tasks | `GET /api/tasks?status=&channelId=`, `POST /api/tasks`, `GET/PUT/DELETE /api/tasks/:id`, `POST /api/tasks/:id/queue|complete|retry|cancel|assign`, `GET /api/tasks/board`, `GET /api/tasks/config`, `GET /api/channels`, `GET /api/agents/types` | task_created/updated/completed/failed/queued/execution_started/progress |
| Settings | `GET/PUT /api/config`, `PUT /api/config/update-pipeline`, `GET /api/models`, `GET /api/health`, `GET /api/update/branches|status`, `POST /api/update/check|apply`, `GET /api/tunnel/status`, `POST /api/tunnel/install-cli|login|enable|disable`, `POST /api/restart`, `GET /api/data-dir`, `POST /api/browse-folder|validate-path|migrate-data`, `GET /api/memory/sources`, `POST /api/memory/sources/scan`, `POST /api/memory/sources/:id/status`, `GET /api/comm-channels/prerequisites|status|health|incidents`, `POST /api/comm-channels/toggle|resume`, `GET /api/completion-notifications/status`, `GET /api/audio-synthesis/status` | — |
| Permissions | `GET/PUT /api/permissions`, `POST /api/permissions/seed`, `GET /api/permissions/audit|audit/count|audit/stats`, `POST/DELETE /api/permissions/rules[/:id]`, `POST /api/permissions/trust-patterns/:id/accept|revoke`, `DELETE …/delete`, `PUT /api/permissions/agents/:name` (+ `/dry-run`), `POST …/reset-trust`, `DELETE …` | permission_request/decision (toasts via chat) |
| Tools | `GET /api/tools`, `PUT /api/tools/:name {enabled}`, `POST /api/tools/scan`, `GET /api/tools/mcp`, `POST /api/tools/mcp`, `DELETE /api/tools/mcp/:name` | — |
| Artifacts | `GET /api/artifacts?date=&start_date=&end_date=&source=&tag=&search=&offset=&limit=`, `GET /api/artifacts/:id`, `GET /api/artifacts/:id/path`, `PUT /api/artifacts/:id`, `DELETE /api/artifacts/:id` | — |
| Pins | `GET /api/pins[?folderId=]`, `POST /api/pins`, `GET /api/pins/check/:messageId?channelId=`, `DELETE /api/pins/:id`, `PUT /api/pins/:id/move`, `GET/POST /api/pins/folders`, `PUT/DELETE /api/pins/folders/:id` | — |
| Usage | `GET /api/usage/summary|by-channel|by-model|by-date|recent` | — |
| Squad | `GET /api/channels/:id/squad/dashboard|status`, `POST /api/channels/:id/squad/init`, `DELETE /api/channels/:id/squad`, `GET /api/agents/types`, `GET /api/tasks`, `POST /api/tasks` | squad_* (refresh) |
| Plugin Gallery | `GET /api/agency/gallery/status|setup|installed|install-state|search|plugin/:id`, `POST /api/agency/gallery/install|force-update|uninstall|refresh|setup|publish`, `POST /api/agency/install-agency` | — |
| Agency Terminal | (none — WS only) | pty_open/input/resize/close/kill_persistent/list_persistent (send); pty_data/exit/error/persistent_list/persistent_killed (recv) |
| World | `GET /api/agents/active` (poll) | squad_* (tick) |
| Channel Manager | `PUT /api/channels/:id`, `POST/DELETE /api/channels[/:id]` | channel_created/archived |

> Note: the README "REST API" table lists the canonical core endpoints (health, config, models, tools, agents, sessions, schedules, memory, tasks, audit, artifacts, channels/squad). The UI also calls additional namespaces not in that table (pins, usage, permissions, comm-channels, tunnel, update, data-dir, agency gallery/publish, memory sources/graph/audit/limits, audio-synthesis) — verified present in the bundled SPA at HEAD.

### Keyboard shortcuts

| Shortcut | Context | Action |
|---|---|---|
| Enter | Chat input (idle) | Send message |
| Enter | Chat input (busy) | Inject context |
| Shift+Enter | Any textarea | Newline |
| Esc | Chat | Stop agent (cancel current turn) |
| Esc | Modals / panels / mobile sidebar | Close modal / reasoning panel / sidebar / detail |
| Alt+S | Chat | Toggle mic / speech-to-text |
| Ctrl/Cmd+Enter | Compose modal | Send reply |
| ↑ / ↓ | Chat input edges | Command history back/forward |
| Enter / Space | Focused nav item | Navigate |
| Enter | Memory search box | Run search |
| Esc | Memory search box | Clear search |
| Click / Tab | World canvas | Select agent |
| ← ↑ ↓ → | World canvas | Select nearest agent in direction |
| Enter | World canvas | Jump to selected agent's stream |
| Esc | World canvas | Close inspector |
| F / D / ? | World canvas | Follow-cam / debug overlay / help |
| Enter | Agency Terminal cwd field | Open session |
| Esc | Agency Terminal new form | Hide form |
| Shift+Enter | Plugin Gallery setup/CLI | Re-check |
| Right-click | Assistant message | Context menu (copy/reply/pin/compose/info) |
| Swipe-right (touch) | Message | Reply |

### Connection & auth contract

- WebSocket URL: `ws://` or `wss://` + `location.host` (same origin as the SPA).
- On open the client sends `{type:'auth',token:<token>,clientKind:'ui'}`; token is `window.__CLAW_TOKEN__` (empty if none).
- On `auth_ok` the client sends `{type:'connect',sessionName:<channel|'general'>}` and `{type:'list_channels'}`.
- Status indicator: dot + text shows "Connecting..." (initial), "Connected" (on `connected`), "Reconnecting…" (on close); reconnect uses backoff and resumes on focus/online/visibility.
- Keepalive: client sends `ping` (~15s) and `presence`; server replies `pong`.
- REST auth: every `/api/*` call sends `Authorization: Bearer <token>` and `credentials: include`.

---

## Coverage notes

- **Verified against live source at HEAD** (`src/web/src/template.html` and `src/web/src/js/*.js`, which `build.js` concatenates verbatim into `dist/index.html`): the view set and DOM ids, the `API()` helper and `T()` token, the WebSocket URL/auth handshake and connection-status strings, and the chat/stream/events/tasks/squad/pty message types. The README's "Web UI (10 views)" copy and "REST API" table were cross-checked; the README undercounts views (the shipped SPA has ~18 routable views including Skills, Pins, Usage, Permissions, Channel Manager, Agency Terminal, Plugin Gallery, World, plus Squad surfaces) and lists only core endpoints.
- **Method confidence.** Most endpoint paths are confirmed verbatim from source; a few HTTP methods/body shapes for less-central namespaces (usage, agency gallery, some permissions/comm-channels routes) were read from the client call sites and may differ in exact query/body naming on the server. Treat the path + intent as authoritative and the request body field names as indicative where the table marks them inline.
- **Intentionally excluded** (per scope): CSS/visual styling details, internal JS function names beyond what is needed to name a control, framework/library specifics (highlight.js, Cytoscape, xterm.js are inlined dependencies), and the mobile slide-in implementation mechanics (each management view has a parallel `#<view>-mobile-detail` panel mirroring the desktop detail pane).
- **Gaps / not fully traced:**
  - Exact auto-update modal/overlay copy and the precise `/health` poll cadence during update are described behaviorally, not transcribed.
  - The full per-`squad_*` and per-`pty_*` message field schemas are summarized from the client handlers; server-emitted optional fields beyond those the UI reads are out of scope.
  - The Reasoning Inspector's data source (which WS fields populate Steps vs Activity) is described at the control level only.
  - World sprite/zone layout specifics are summarized; pixel-exact tilemap coordinates are out of scope for behavior replication.
  - "Help" nav item opens a help surface whose contents were not separately enumerated.
