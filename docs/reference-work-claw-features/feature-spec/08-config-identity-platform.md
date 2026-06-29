# Feature Spec 08 — Configuration, Identity & Platform

## 1. Overview

This subsystem governs **who the agent is**, **how it is configured**, **how it is constrained**, and **how it runs on a user's machine**. A single JSON file (`claw.json`) defines the agent's name, emoji, model, behavior dials, escalation policy, heartbeat, and integration settings. A set of markdown "soul" files (SOUL.md, USER.md, MEMORY.md, AGENTS.md, etc.) define the agent's personality and operating rules, which are budget-truncated and composed into a layered XML-fenced system prompt at every turn. **Channels** are named conversation contexts (stored separately in `channels.json`) that can each override the global model and reasoning effort and filter the available tool set. A **PermissionEngine** with a 5-level autonomy dial (persisted in `permissions.json`) decides whether each tool call is allowed, denied, or escalated to the human, recording every action to an append-only `audit.log` and a rolling structured audit buffer. The **platform layer** is a native Windows desktop app (WinForms + WebView2 hosting the local daemon at `127.0.0.1:3117`) plus PowerShell/shell scripts that install prerequisites, bootstrap the `~/.claw/` workspace, register a daemon watchdog, run an onboarding wizard, and handle updates and uninstall.

> **Replication note — two documented-but-inert contracts.** Two features appear in `README.md`/`HELP.md` but are **not implemented at HEAD**: (a) the **custom provider / BYOK** block (`provider {...}`) is never parsed, validated, or passed to the LLM transport; (b) three of the four `escalation` config fields (`high_complexity`, `low_complexity`, `log_all_actions`) are declared and defaulted but **never read at runtime**. The substantive permission system is the separate `PermissionEngine` autonomy dial. Both are documented in detail below and flagged as **SPECIFIED-BUT-UNIMPLEMENTED** so a re-implementer can choose to honor the documented contract or replicate the (inert) current behavior.

---

## 2. Feature Inventory Checklist

- [ ] **F1 — `claw.json` config schema & loader** (deep-merge of user config over defaults; nested-object merge; secret redaction on read; forbidden keys on API write)
- [ ] **F2 — Agent identity** (`agent_name`, `agent_emoji` → `<identity>` block; name substituted into prompt)
- [ ] **F3 — Workspace bootstrap** (`ensureWorkspace`: creates `~/.claw/` tree + default soul files + config + `structured.json` + `tools.json`)
- [ ] **F4 — Data-dir indirection** (`bootstrap.json` `{data_dir}` redirects precious content to a cloud-synced folder)
- [ ] **F5 — Soul files** (SOUL.md, USER.md, MEMORY.md, TASKS.md, AGENTS.md, BOOT.md, structured.json, tools.json — roles & defaults)
- [ ] **F6 — System-prompt assembly** (`assembleSystemPrompt`: identity + soul + rules + human + memory + today + tasks + schedules + skills + tools, each budget-truncated; XML fences; security rules)
- [ ] **F7 — Context budget allocator** (per-section token caps + truncation strategies)
- [ ] **F8 — Channels: data model & storage** (`channels.json`, `Channel` schema, reserved IDs, ID slugging)
- [ ] **F9 — Per-channel tool filtering** (`availableTools` allowlist beats `excludedTools` blocklist)
- [ ] **F10 — Per-channel model & reasoning-effort override** (precedence: caller option → channel → global config; live-apply)
- [ ] **F11 — Channel CRUD REST API** + override validation
- [ ] **F12 — Communication channels** (reserved `email`/`teams` channels auto-provisioned with system-prompt overlays)
- [ ] **F13 — Custom provider / BYOK** *(SPECIFIED-BUT-UNIMPLEMENTED)*
- [ ] **F14 — Escalation config block** *(only `escalation.default` read; other 3 fields inert)*
- [ ] **F15 — PermissionEngine & autonomy dial** (5 levels, 14 action categories, decision matrix, `permissions.json`)
- [ ] **F16 — Live permission approval round-trip** (WebSocket `permission_request`/`permission_response`, 30s timeout, learned rules)
- [ ] **F17 — Audit log** (append-only tab-separated `audit.log` + structured rolling buffer in `permissions.json`)
- [ ] **F18 — Post-tool-use & error hooks** (`onPostToolUse` trust tracking; `onErrorOccurred` retry-up-to-2)
- [ ] **F19 — Permissions REST API** (manage autonomy level, rules, trust patterns, agent profiles, audit views)
- [ ] **F20 — Desktop app** (WinForms + WebView2, single-instance mutex, tray, close-to-tray, daemon auto-start)
- [ ] **F21 — `claw app` command** (launch/build desktop exe; browser fallback off-Windows)
- [ ] **F22 — Install scripts** (`scripts/install.ps1`/`.sh`, `setup.ps1`/`.sh`: prereqs, auth, build, link)
- [ ] **F23 — `claw setup` path** (`setupAll`: prereqs → onboarding → daemon start → desktop build → auto-start)
- [ ] **F24 — Onboarding wizard** (CLI/MSI: collect agent name + emoji; model fixed)
- [ ] **F25 — Watchdog & auto-start** (Startup-folder VBS launcher + `Work-Claw Daemon Watchdog` scheduled task; LaunchAgent/systemd on POSIX)
- [ ] **F26 — Update flow** (`update.ps1` git-clone bootstrap → `post-update.ps1` rebuild; channel→branch mapping)
- [ ] **F27 — Uninstall flow** (`uninstall.ps1`: stop daemon, remove tasks/links/shortcuts/tunnel/workspace)

---

## 3. Detailed Feature Entries

### F1 — `claw.json` config schema & loader

**Purpose.** Single source of truth for agent identity and behavior. Loaded once per system-prompt assembly and per orchestrator init.

**Trigger.** `loadConfig()` is called by `assembleSystemPrompt`, `orchestrator.initialize`, the daemon API, and most subsystems.

**Inputs.** The on-disk file `<data_dir>/claw.json` (JSON). Full schema in the **Data & formats** appendix (§4.1).

**Behavior (load rules).**
1. If `claw.json` does not exist → return a clone of `DEFAULT_CONFIG`.
2. If it exists → `merged = { ...DEFAULT_CONFIG, ...userConfig }` (shallow), **then deep-merge** every nested object so user entries **extend** rather than replace defaults. Nested keys that get `{ ...defaults, ...user }` merge: `sub_agent_models`, `escalation`, `heartbeat`, `theme`, `auto_update`, `tunnel`, `memory_limits`, `comm_channels`, `knowledge_base`, `agency`, `auth`, `plugins`, `audio_synthesis`, `daemon`, `completion_notifications`, `large_output`.
3. For each nested key: if the user value is `null`/`undefined`, keep `{ ...defaults }`. If the user value is a non-object/array where defaults are an object, the shallow spread already replaced it (defaults lost for that key).
4. `comm_channels.email`/`.teams` and `completion_notifications.email`/`.teams` are each deep-merged one level deeper.
5. `audio_synthesis.provider` is deep-merged so partial local-command config keeps safe defaults (esp. `provider.kind`).
6. **`autoDownloadUpdates` ↔ `auto_update.enabled` reconciliation:** if the user did not supply a boolean `autoDownloadUpdates`, it is derived from `auto_update.enabled ?? true`; then `auto_update.enabled` is forced to equal the resolved `autoDownloadUpdates`.

**Output / effect.** A fully-populated `ClawConfig` object. `saveConfig(config)` writes it back verbatim with 2-space indentation (no secret extraction).

**Edge cases & errors.**
- Malformed JSON → `JSON.parse` throws (not caught in `loadConfig`); callers must handle.
- **API write guard:** `PUT /api/config` rejects (HTTP 400) any of these keys: `install_dir`, `remote_url`, `update_channel`, `auto_update`, `autoDownloadUpdates`, `data_dir`, `provider` — error message: *"These config keys cannot be modified via the API: <keys>. Edit claw.json directly or run 'claw setup'."*
- **API read redaction:** `GET /api/config` recursively masks fields matching `^api[_-]?key$`, `^token$`, `_token$`, `^password$`, `^secret$`, `_secret$`, `^flow_url$` → `"[REDACTED]"`. **Note:** `bearerToken` is NOT matched by these anchored patterns and would leak unredacted.

**Configuration.** The file itself; `/config set <key> <value>` CLI command for scalar fields.

**Dependencies.** `DEFAULT_CONFIG` (defaults.ts), `getConfigPath()` → `<data_dir>/claw.json`.

**Example.** See §4.1 for a complete example file.

---

### F2 — Agent identity

**Purpose.** Give the agent a stable name and emoji it identifies with fully.

**Trigger.** Every `assembleSystemPrompt` call.

**Inputs.** `config.agent_name` (default `"CLAW"`), `config.agent_emoji` (default `"🦀"`).

**Behavior.** The loader emits a fixed `<identity>` block:
```
<identity>
Your name is {agent_name} {agent_emoji}. You are {agent_name}, not "CLAW" or any other name.
Always refer to yourself as {agent_name}. When asked who you are, say you are {agent_name}.
This is your true identity — it was given to you by your human and is part of who you are.
</identity>
```
The agent name is **also substituted into SOUL.md** during onboarding (`applyOnboarding`).

**Output / effect.** The model adopts the configured name in all responses.

**Edge cases.** If `agent_name`/`agent_emoji` are falsy at assembly time, the loader falls back to `"CLAW"` / `"🦀"`.

---

### F3 — Workspace bootstrap (`ensureWorkspace`)

**Purpose.** Idempotently create the `~/.claw/` (or data-dir) tree and seed default files on first run.

**Trigger.** Called during daemon startup and `claw setup`.

**Behavior (in order).**
1. `ensureDir` for: workspace root, `memory/`, `sessions/`, `skills/`, `agents/`, `tmp/` (each `mkdir -p` with mode `0o700`; Windows ignores mode).
2. Write each default soul file **only if it does not already exist**: `SOUL.md`, `AGENTS.md`, `USER.md`, `BOOT.md`, `MEMORY.md`, `TASKS.md` (contents from `defaults.ts`).
3. Write `claw.json` from `DEFAULT_CONFIG` if missing.
4. Write `structured.json` = `{ people: [], projects: [], preferences: [], facts: {} }` if missing.
5. Write `tools.json` if missing, seeded with one WorkIQ MCP server. **Windows popup-storm mitigation:** instead of `npx -y @microsoft/workiq mcp` (which flashes a cmd window), it probes known global npm module dirs for `@microsoft/workiq/bin/workiq.js` and, if found, uses `node <abs-path> mcp`; else falls back to npx. If `tools.json` already exists, it is normalized (guards against non-object/array JSON), WorkIQ is added if absent, and legacy npx entries are migrated to node-direct on Windows.
6. Bootstrap built-in skill-agent definitions (~20 `.md` files such as `code.md`, `research.md`, `outlook.md`, `s360.md`, …) into `agents/`, **never overwriting user edits**; ensure a skill-memory dir per agent; copy bundled skill scripts.
7. Runtime migrations for existing installs: ensure the "Mandatory Recall Ladder" block in AGENTS.md and the managed outbound-safety blocks in SOUL.md/AGENTS.md/select custom agents, both idempotent and non-clobbering.

**Output / effect.** A complete, ready workspace. See §4.4 for the tree.

**Edge cases.** Existing files are never overwritten (preserves user edits). A corrupt `tools.json` is repaired without throwing.

---

### F4 — Data-dir indirection (`bootstrap.json`)

**Purpose.** Let "precious" user content live in a cloud-synced folder (OneDrive/Dropbox) while transient runtime files stay local.

**Inputs.** `<runtime_dir>/bootstrap.json` = `{ "data_dir": "<absolute path>" }`. `runtime_dir` = `$CLAW_WORKSPACE` or `~/.claw`.

**Behavior.**
- `getDataDir()` = `bootstrap.data_dir || runtime_dir`. **Precious** content (soul files, `claw.json`, `channels.json`, `sessions/`, `memory/`, `agents/`, `structured.json`, `permissions.json`, …) resolves under `data_dir`.
- **Runtime/transient** content (`audit.log`, `daemon.log`, `tmp/`, `logs/`) always resolves under `runtime_dir` regardless of `data_dir`.
- `saveBootstrap` validates `data_dir` is a non-empty **absolute** path with **no `..` traversal segments** (checked on the raw input before normalization), then normalizes and writes.

**Output / effect.** All path helpers transparently follow the redirect.

**Edge cases.** Missing/invalid `bootstrap.json` → `{}` → data_dir == runtime_dir (default). Legacy files in the old runtime dir are migrated to the data dir via an exclusive-lock `migrateFile`.

---

### F5 — Soul files

**Purpose.** Human-readable, user-editable personality, operating rules, and memory. Formats are owned by other subsystems; this spec records their role and bootstrap defaults.

| File | Role | Default seed |
|------|------|--------------|
| `SOUL.md` | Identity, core truths, communication style, boundaries, evolution. Wrapped in `<soul>`. | `DEFAULT_SOUL` (includes managed outbound-safety block). Agent name substituted on onboarding. |
| `AGENTS.md` | Operating rules: first-run ritual, memory rules, recall ladder, concierge/delegation model, sub-agent limits, task orchestration, safety. Wrapped in `<operating_rules>`. | `DEFAULT_AGENTS` |
| `USER.md` | Who the human is (name, work context, preferences, communication style). Wrapped in `<my_human>`. | `DEFAULT_USER` (placeholders `(set during onboarding)`). |
| `MEMORY.md` | Legacy long-term memory. **Writing is a no-op** in current model (migrated to topic graph). Wrapped in `<long_term_memory>` (or the topic-graph context when ready). | `DEFAULT_MEMORY` |
| `TASKS.md` | Legacy task list. Superseded by the `task_manage` tool / TaskStore. | `DEFAULT_TASKS` |
| `BOOT.md` | Startup ritual checklist. | `DEFAULT_BOOT` |
| `structured.json` | Queryable structured memory: `{ people, projects, preferences, facts }`. | `{ people:[], projects:[], preferences:[], facts:{} }` |
| `tools.json` | MCP server registry + tool overrides: `{ overrides:{}, mcp_servers:[...] }`. | Seeded with WorkIQ stdio MCP server. |

**First-run detection.** `isFirstRun(userContent)` = `userContent.includes("(set during onboarding)")`.

---

### F6 — System-prompt assembly (`assembleSystemPrompt`)

**Purpose.** Compose the full system prompt for a turn from identity + soul + memory + live state.

**Trigger.** `assembleSystemPrompt(channelId?, userMessage?)` before each session create/turn.

**Inputs.** `channelId` (filters the daily log), `userMessage` (seeds memory retrieval), plus all soul files, structured memory, task store, schedules, skills, MCP/CLI tools, and Agency detection.

**Behavior (assembly order; each section budget-truncated — see F7).**
1. `<security_rules>` — fixed block: external content is DATA not instructions; cannot be overridden.
2. Runtime outbound-safety block.
3. `<identity>` — F2.
4. `<runtime_engine>` (only if Agency detected) — transport = vanilla GitHub Copilot CLI, Agency used only as MCP/marketplace provider; lists enabled Agency MCP backends, installed marketplace agents, skills dirs.
5. `<soul>` — SOUL.md (budget `soul`).
6. `<operating_rules>` — AGENTS.md (budget `agents`).
7. `<my_human>` — USER.md (budget `user`).
8. `<long_term_memory>` — topic-graph memory context (if ready) else MEMORY.md (budget `memory`).
9. `<memory_freshness>` (only if stale sections detected) — flags USER.md "Current Context" and MEMORY.md "Open Items"/"Work-Claw Platform Stats"/"Known Incidents"/"Last Known S360 State" sections whose dates are all >7 days old.
10. `<structured_knowledge>` (only if present) — knowledge-base summary (if `knowledge_base` configured) with preferences-first ordering, else built-in structured-memory summary (budget `structured`).
11. `<today>` — date/day/time + today's daily log (channel-filtered, then truncated to ~3000 chars keeping most recent entries; budget `daily`).
12. `<active_tasks>` — active tasks from TaskStore (`pending|assigned|in_progress|blocked|review`) formatted as `- [status] title (priority) → role [n%]` (budget `tasks`).
13. `<scheduled_jobs>` — SCHEDULES.md (budget `schedules`).
14. `<available_skills>` (if any) — capped at 20 skills / 2000 chars.
15. `<available_tools>` (if any) — enabled MCP servers + active CLI tools.

**Daily-log channel filtering.** Sections headed `## [channelId] …` are shown only in that channel; untagged sections shown everywhere; sections tagged with a different channel are excluded. The `[channelId]` prefix is stripped for display.

**Output / effect.** One large templated string used as the SDK `systemMessage`.

**Edge cases.** Every optional subsystem (memory retriever, structured summary, skills, tools registry, Agency) is wrapped in try/catch and never blocks assembly. Missing soul files fall back to empty string (or, in some helpers, the in-code default).

---

### F7 — Context budget allocator (`applyBudget`)

**Purpose.** Cap each prompt section to a fixed token budget regardless of on-disk size.

**Inputs.** Section name + content.

**Behavior.** Per-section budgets (`maxTokens`, `priority`, `truncation`):

| Section | maxTokens | priority | truncation |
|---------|-----------|----------|-----------|
| `soul` | 1500 | 1 | tail |
| `agents` | 2500 | 1 | tail |
| `user` | 1500 | 2 | sections |
| `memory` | 2500 | 3 | sections (smart TOC) |
| `structured` | 1800 | 2 | tail |
| `daily` | 1000 | 3 | head |
| `tasks` | 800 | 2 | tail |
| `schedules` | 150 | 4 | tail |

Token estimate via `estimateTokens` (~4 chars/token). If under budget → pass through. Truncation strategies: **tail** (keep beginning, append `*[truncated — use memory_read…]*`), **head** (keep end, prepend `*[older content omitted…]*`), **sections** (split on `## `, score & keep highest-scored within budget, re-emit in original order, note omitted count), and **memory** uses a smart table-of-contents mode. Unknown section names pass through unchanged. Total budget ≈ 11.7K tokens.

---

### F8 — Channels: data model & storage

**Purpose.** Named, persistent conversation contexts with per-channel state and overrides.

**Storage.** `<data_dir>/channels.json` holding `{ channels: Channel[], activeChannelId: string }`. Atomic write via `.tmp`→rename; crash-recovery promotes a valid `.tmp`; a corrupt file is backed up to `channels.json.backup-<epoch>` and defaults re-initialized. **Not** created by `ensureWorkspace`; lazily initialized on first store access.

**`Channel` schema (every field).** See §4.2. Key facts:
- `id` is the **session name** → session file `sessions/{id}.json`.
- On create, `id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")`.
- **Reserved IDs:** `{ "general", "email", "teams" }` — cannot be user-created or archived.
- Default channel: `{ id:"general", name:"General", emoji:"🦀", description:"Default catch-all channel", pinned:true, hidden:false }`; `activeChannelId` defaults to `"general"`.

**No `kind`/`type` discriminator.** All channels share one schema; the distinction is by reserved ID and creator. Squad channels are normal channels with a `squad` object set.

**Output / effect.** Each channel maps 1:1 to an SDK session; `lastActiveAt`/`unreadCount` track activity.

**Edge cases.** Creating a name that slugs to a reserved ID throws; duplicate IDs throw (409 via API). Archiving the active channel resets `activeChannelId` to `"general"`.

---

### F9 — Per-channel tool filtering

**Purpose.** Restrict which tools an agent may use within a channel.

**Inputs.** `Channel.availableTools?: string[]` (allowlist) and `Channel.excludedTools?: string[]` (blocklist).

**Behavior (precedence: allowlist beats blocklist).** When connecting/resuming a session, both arrays are conditionally spread into the SDK `createSession` call:
```ts
...(toolFiltering.availableTools ? { availableTools: toolFiltering.availableTools } : {}),
...(toolFiltering.excludedTools ? { excludedTools: toolFiltering.excludedTools } : {}),
```
- `availableTools` non-empty → SDK restricts to exactly that set; `excludedTools` **ignored**.
- `availableTools` empty/undefined → no allowlist; `excludedTools` (if non-empty) disables those tools.
- Both empty/undefined → all tools available.

> **Replication note.** The "allowlist beats blocklist" precedence is enforced **inside the GitHub Copilot SDK's `createSession`**, not in this codebase. CLAW's only role is the conditional spread. A from-scratch implementation must re-implement this rule in its SDK shim: *if `availableTools` is non-empty, ignore `excludedTools` and restrict to the allowlist.*

**Squad interaction.** On squad init, squad tools (`squad_route`, `squad_decide`, `squad_memory`, `squad_status`, `squad_skill`) are unioned into the channel's allowlist **only if one already exists** (otherwise left undefined so all tools stay available); removed on squad destroy, clearing the allowlist to `undefined` if it becomes empty.

**Sub-agents** do NOT inherit channel tool filtering; they only restrict tools if their custom-agent frontmatter opts in.

---

### F10 — Per-channel model & reasoning-effort override

**Purpose.** Let a channel run on a different model and/or reasoning effort than the global config. (Added in #215.)

**Inputs.** `Channel.model?: string`, `Channel.reasoningEffort?: "low"|"medium"|"high"|"xhigh"`.

**Behavior (precedence: explicit caller option → channel override → global config).**
```ts
const channelModel = options?.model ?? channel?.model;
const channelReasoningEffort = options?.reasoningEffort ?? channel?.reasoningEffort;
```
These flow into `orchestrator.initialize(effectiveModel, …, channelReasoningEffort)`, which applies them over the loaded config:
```ts
if (modelOverride)            config = { ...config, model: modelOverride };
if (reasoningEffortOverride)  config = { ...config, reasoning_effort: reasoningEffortOverride };
```
When the override is absent (`undefined`/falsy), the global `config.model` / `config.reasoning_effort` is used. Allowed reasoning values: `VALID_REASONING_EFFORTS = ["low","medium","high","xhigh"]`. The global `reasoning_effort` is **not** in `DEFAULT_CONFIG`; when neither channel nor config sets it, the SDK default applies.

**Clearing an override.** `updateChannel` deletes the field when the update value is empty/falsy, so the channel falls back to the global default. On create, overrides are conditionally included (unset → absent key).

**Live application.** `PUT /api/channels/:id` applies model/reasoning changes to a **running** session without reconnect, but **only when the stored override actually changed**. It resolves `model = ch.model || cfg.model` and `reasoningEffort = ch.reasoningEffort || cfg.reasoning_effort`, then calls `switchModel(...)` with `applyReasoning:true` (a falsy effort **deletes** `config.reasoning_effort`, reverting to default). Mid-session it uses the SDK `setModel`, preserving history.

**Output / effect.** The channel's next turn uses the resolved model + reasoning effort. The web UI shows an "override" vs "inherited" badge.

---

### F11 — Channel CRUD REST API + validation

**Purpose.** Create/read/update/archive channels and validate overrides.

**Endpoints (all under `/api/channels`).**

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/channels` | List all channels. |
| POST | `/api/channels` | Create. Rejects names slugging to `general` (400). Validates overrides. 201 success / 409 duplicate. |
| GET | `/api/channels/:id` | Get one; 404 if missing. |
| PUT | `/api/channels/:id` | Update. Rejects squadifying `general` (400). Validates overrides. Live-applies model/reasoning changes. |
| DELETE | `/api/channels/:id` | Archive; 400 if reserved/unknown. |
| GET | `/api/channels/:id/history` | `{ channelId, messages }`. |
| POST/DELETE/GET | `/api/channels/:id/squad[...]` | Squad init/destroy/dashboard/status. |

**Override validation (`validateChannelOverrides`).** Returns an error string (→ 400) when: `model` present and non-null but not a string ("model must be a string"); `reasoningEffort` present, non-null, non-empty, and not in `VALID_REASONING_EFFORTS` ("reasoningEffort must be one of: low, medium, high, xhigh"). Null/empty values are allowed and clear the override. `availableTools`/`excludedTools` are not validated here (pass through the updatable-key whitelist: `name|emoji|description|pinned|hidden|systemPromptOverlay|availableTools|excludedTools|squad|model|reasoningEffort`).

---

### F12 — Communication channels (`email`/`teams`)

**Purpose.** Reserved channels for self-email and Teams self-chat that the daemon auto-provisions.

**Behavior.** At startup `createReservedChannel("email")` / `("teams")` idempotently create:
- email: `{ id:"email", name:"Email", emoji:"📧", description:"Self-email communication channel", pinned:true, hidden:false }`
- teams: `{ id:"teams", name:"Teams", emoji:"💬", description:"Teams self-chat communication channel", pinned:true, hidden:false }`

Each gets a `systemPromptOverlay` instructing concise, conversational, HTML-email/Teams-chat-friendly replies with full tool/memory access. Inbound routing keys on `channelId === "email"`/`"teams"`. These channels are governed by the `comm_channels` config block (poll intervals, activation mode, rate limits — see §4.1).

---

### F13 — Custom provider / BYOK *(SPECIFIED-BUT-UNIMPLEMENTED)*

**Purpose (documented intent).** Use a custom API provider (Azure OpenAI, Anthropic, or any OpenAI-compatible endpoint) instead of the default GitHub Copilot transport.

**Documented schema (top-level `provider` field in `claw.json`).**

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `type` | `"openai"`\|`"azure"`\|`"anthropic"` | optional | `"openai"` | Provider type. |
| `baseUrl` | `string` | **required** | — | API endpoint URL. |
| `apiKey` | `string` | optional | — | API key. |
| `bearerToken` | `string` | optional | — | **Takes precedence over `apiKey`.** |

**Documented precedence rules.** (a) `baseUrl` always required for a custom provider; (b) `bearerToken` wins over `apiKey`; (c) when a provider is set, `model` is **required** and must match the provider's model identifier.

**ACTUAL behavior at HEAD.** The `provider` block is **inert**: it is not in the `ClawConfig` type, not parsed/validated by `loadConfig`, not passed to the SDK (`createSession` passes only `model: config.model` + system/tools/hooks), no precedence/validation/env-var code exists, and no `OPENAI_*`/`ANTHROPIC_*`/`AZURE_*` env vars are read or set. The only runtime touch-points: `PUT /api/config` **rejects** a `provider` key (forbidden), and `GET /api/config` redacts `provider.apiKey` (but **not** `provider.bearerToken`). The intended SDK wiring exists only as a comment in the architecture doc: `provider: config.provider`.

**Re-implementer guidance.** Choose one: (A) honor the documented contract — validate `baseUrl` present, `model` present, `bearerToken` over `apiKey`, branch per `type`, and feed the SDK/transport; or (B) replicate current behavior — treat `provider` as documented-but-non-functional, rejected on API write, partially redacted on read.

---

### F14 — Escalation config block *(mostly inert)*

**Purpose (documented).** Control whether actions are auto-attempted or escalated to the human, by complexity, and whether all actions are logged.

**Inputs / schema.**
```ts
escalation: {
  default:         "ask" | "attempt",   // default "ask"
  high_complexity: "ask" | "attempt",   // default "ask"
  low_complexity:  "ask" | "attempt",   // default "attempt"
  log_all_actions: boolean,             // default true
}
```

**ACTUAL behavior at HEAD.** Only `escalation.default` is read, by the secondary SDK-level `onPermissionRequest` handler:
```ts
const action = config?.escalation?.default || "attempt";
if (action === "attempt") return { kind: "approve-once" };       // auto-approve
return events.onPermissionRequest?.(request) ?? { kind: "approve-once" }; // else delegate to engine
```
`high_complexity`, `low_complexity`, and `log_all_actions` are **declared, defaulted, and never consumed**. "Complexity" gating is a separate **prompt convention**: the `spawn_sub_agent` tool's own `complexity: "low"|"high"` parameter; `high` makes the tool refuse and return text telling the model to ask the human, then re-invoke with `complexity='low'`. Audit logging is **unconditional** (F17), regardless of `log_all_actions`.

**Re-implementer guidance.** The real decision-maker is the PermissionEngine (F15). If replicating current behavior, treat `escalation.default` as the SDK-handler gate and the other three fields as inert config surface.

---

### F15 — PermissionEngine & autonomy dial

**Purpose.** The substantive per-tool-call authorization system. Decides allow / deny / ask / audit-only.

**Storage.** `<data_dir>/permissions.json` = `PermissionStore` (§4.5). Atomic temp-file save. Tolerant load (corrupt → defaults persisted). `normalizeAutonomyLevel` accepts `0–4`, numeric strings, or label strings (`"yolo"`, `"balanced"`, …) — this is why a user's "YOLO" is preserved across restart instead of resetting to Balanced. The file is explicitly preserved (not swept to `tmp/`) by bootstrap.

**Autonomy levels (`AutonomyLevel`).** `Strict=0`, `Supervised=1`, `Balanced=2` (**default**), `Autonomous=3`, `Yolo=4`. UI labels: 🔒 Strict / 🛡️ Supervised / ⚖️ Balanced / 🚀 Autonomous / 🤠 YOLO.

**Action categories (14).** `file_read`, `file_write`, `shell_read`, `shell_write`, `git_read`, `git_write`, `external`, `mcp_tool`, `docker`, `memory`, `agent_spawn`, `agent_lifecycle`, `system_config`, `destructive`.

**Decisions.** `allow`, `deny`, `ask`, `audit_only` (+ user-decision variants).

**Default policy matrix highlights** (`DEFAULT_POLICY[level][category]`):
- **Strict (0):** reads Allow; writes/shell/external/mcp/docker/system_config = Ask; destructive = **Deny**.
- **Balanced (2):** file & shell writes Allow; git_write/mcp/docker/system_config = AuditOnly; external = Ask; destructive = Ask.
- **Autonomous (3):** almost all Allow; external = Ask; destructive = Ask.
- **YOLO (4):** everything Allow; destructive = AuditOnly (logged but allowed).

**Decision pipeline (`evaluate`, called from `onPreToolUse`).**
1. `classifyAction(toolName, toolArgs)` → category + riskScore (0–10) + readOnly. Shell commands are sub-classified by regex; **destructive checked first** so a chained `; rm -rf` cannot be masked.
2. Agent dry-run → Deny.
3. Session-trust elevated category → Allow.
4. Explicit rules (user + learned), matched by category/channel/agent/regex, sorted by priority then specificity.
5. Agent `allowedCategories` override → Allow.
6. Fallback to `DEFAULT_POLICY[level][category]` (per-agent `autonomyOverride` if set), default Ask.

**Learning.** Approvals feed `TrustPattern`s; after 3 approvals the engine suggests an auto-allow rule.

---

### F16 — Live permission approval round-trip

**Purpose.** When a decision is `Ask`, prompt the human and block the tool call until resolved.

**Behavior.**
1. `onPreToolUse` builds an `ApprovalRequest` with `requestId`, `riskScore`, `timeoutSec: 30`, `timeoutDecision = External ? Deny : Allow`.
2. The daemon stores a resolver + a 30s timer in `pendingApprovals` (timer rejects → records `UserTimeout`), and broadcasts a `permission_request` WebSocket message to all UI clients.
3. The UI renders the prompt; the user approves/denies and the client sends `permission_response` = `{ requestId, decision: "allow"|"deny", alwaysAllow?, sessionTrust? }`.
4. Server validates `decision ∈ {allow,deny}`, calls `resolveApproval(requestId, …)` which clears the timer and resolves the Promise.
5. The orchestrator records the user decision (`approvalType ∈ one_time|always_allow|session_trust|denied`); `sessionTrust` → grant session trust; `alwaysAllow` → accept matching trust pattern or add a learned allow-rule; deny → `{ permissionDecision: "deny" }`.
6. Decisions echoed to UI via `permission_decision`; trust suggestions via `trust_suggestion`.

**Edge cases.** Timeout applies `timeoutDecision`. Sub-agents bypass approval entirely (`onPermissionRequest: () => ({ kind: "approve-once" })`).

---

### F17 — Audit log

**Purpose.** Append-only record of all agent actions.

**Two sinks (both unconditional):**

**(a) Text `audit.log`** at `<runtime_dir>/audit.log`. `appendAuditLog(actor, action, detail)` writes one tab-separated line:
```
{ISO-8601 timestamp}\t{actor}\t{action}\t{detail}\n
```
Called for every: `tool_pre`, `tool` (`{status} | args: {first 200 chars of JSON}`), `error`, session start/end, `permission`, and config mutations. (Format detail in §4.6.)

**(b) Structured rolling buffer** in `permissions.json#auditLog` — `PermissionAuditEntry[]`, capped at 1000 (oldest dropped). Entries ≥7 days old archived to `audit-archive-YYYY-MM-DD.json`. Fields: `timestamp, toolName, category, decision, actor, channelId?, ruleId, description, approvalDurationMs?, toolArgs?, riskScore?, approvalType?`.

**Note.** Logging happens regardless of `escalation.log_all_actions` (which is never read).

---

### F18 — Post-tool-use & error hooks

**`onPostToolUse`.** (1) Appends a `tool` line to `audit.log` with status + truncated args; (2) updates the per-agent trust profile: `+0.5` trustScore on success, `-2` on failure (clamped 0–100), tracks success/failure counts and unique tools/categories.

**`onErrorOccurred`.** Logs an `error` line; if `recoverable` → instructs SDK to **retry up to 2 times**; else returns a `userNotification`. Separately, the orchestrator tracks consecutive failures and emits an advisory "stop and ask for help" hint at ≥3 consecutive tool failures.

---

### F19 — Permissions REST API

**Endpoints under `/api/permissions`:**
- `GET`/`PUT` — read/update the store; PUT validates `autonomyLevel` is integer 0–4 and hot-reloads into live sessions.
- `POST`/`DELETE /rules[/:id]` — manage rules (valid categories/decisions enumerated; regex capped at 256 chars to prevent ReDoS).
- `GET /trust-patterns`, `.../accept`, `.../revoke`, `DELETE` — manage learned trust.
- `GET /audit[/count|/stats]` — paginated audit views.
- `GET /agents`, `.../dry-run`, `.../reset-trust`, `PUT /:agent` (override autonomy/allowedCategories), `DELETE` — agent profiles (changes are themselves audited).

The web UI renders the 5-position autonomy dial and posts `{ autonomyLevel: level }`.

---

### F20 — Desktop app (WinForms + WebView2)

**Purpose.** Native Windows shell hosting the local daemon's web UI.

**Build target.** .NET 8 WinForms (`net8.0-windows`), `OutputType=WinExe` (no console), `AssemblyName=claw-desktop` → `claw-desktop.exe`, `win-x64`, single-file, framework-dependent (needs shared .NET 8 runtime), single dep `Microsoft.Web.WebView2`. Published to `bin/Release/net8.0-windows/win-x64/publish/`.

**Single-instance.** Named mutex `Global\ClawDesktopSingleInstance`. A second launch does not open a window; it finds the existing process, restores it if minimized (`ShowWindow SW_RESTORE`), and `SetForegroundWindow`s it. (No named pipe.)

**Port.** Default `3117`, overridable via `--port=NNNN` arg. `claw app` always passes the daemon's actual resolved port. All URLs use `http://127.0.0.1:{port}` (`/health`, root navigation, `POST /api/shutdown`).

**Window behavior.** Title "Work-Claw", 1100×750 (min 600×400), dark `#18181C`. Shows a loading label through daemon-startup phases. **Close → minimize to tray** (cancels user-close, `Hide()`, balloon tip). **Minimize → hide to tray.** Only "Quit" truly exits.

**WebView2.** Before navigating, checks `/health` (2s timeout); if down, runs `StartDaemon()` (prefers bundled `claw-daemon.exe`, falls back to `claw-daemon start` via PATH) and polls every 500ms up to 30s. User-data folder `%LOCALAPPDATA%\ClawDesktop`. External links open in the system browser. Microphone permission granted only for the `127.0.0.1:{port}` origin. Title bar mirrors page title.

**Tray menu (in order):** "Show Work-Claw" → restore; (sep); "Restart Daemon" → `POST /api/shutdown`, wait, restart, reload, balloon; (sep); "Quit" → dispose tray + `Application.Exit()`. Double-click tray icon → show window.

---

### F21 — `claw app` command

**Purpose.** Launch the desktop app (Windows) or the web UI (other OS).

**Behavior.** `ensureDaemonRunning()` resolves the daemon port. **Non-Windows:** open `http://localhost:{port}` in browser. **Windows:** locate `~/.claw/desktop/claw-desktop.exe`; if missing, build it on the fly (`dotnet publish -c Release`, 120s timeout, copy publish output + `claw.ico` into `~/.claw/desktop`); on build failure fall back to browser. Launch detached with `--port={port}`.

---

### F22 — Install scripts

**`scripts/install.ps1` (Windows release MSI).** Requires `gh` + `gh auth status`; downloads MSI via `gh release download` (`*windows-msi*.msi`); installs with `msiexec /i … /norestart` (+ `/qn` quiet or `/passive`); tells user to run `claw setup`.

**`scripts/install.sh` (POSIX).** Requires `gh` + auth. macOS: download `*.pkg`, `sudo installer -pkg … -target /`. Linux: from source — requires git/node/npm, enforces **Node ≥ 22**, `gh repo clone --depth 1`, `npm ci --ignore-scripts && npm run build && npm link`.

**`setup.ps1` (Windows from-source).** Param `-Channel stable|dev` (stable→branch `main`, dev→branch `dev`), `-SkipAgency`. Steps: (1) **Prereqs** via winget — Node (≥22, hard requirement), Git, gh (all required); PowerShell 7 (recommended); .NET SDK 8, devtunnel, Agency CLI (optional). Restart-gate if a tool isn't yet on PATH. (2) `gh auth`. (3) `npm install`. (4) `npm link`. (data-dir prompt → write `bootstrap.json`). (5) `claw setup`. (6) register watchdog.

**`setup.sh` (POSIX).** `--channel=dev|stable`. Node ≥22/Git/gh required; az/Agency optional. `npm install`, `npm link`, `playwright install chromium`, `claw setup`, then watchdog (macOS LaunchAgent or Linux systemd user timer honoring `watchdog_interval_minutes`/`watchdog_enabled`).

---

### F23 — `claw setup` path (`setupAll`)

**Behavior.** Detects MSI vs git install (`.claw-install-marker`); MSI installs skip desktop-build + VBS auto-start. Persists `install_dir` + git `remote_url`; copies `update.ps1`/`setup.ps1` into the data-dir `scripts/`. Steps: (1) **Prereqs** — Node ≥22 (hard), gh present + authed, Copilot SDK available. (2) **Workspace** — if onboarding needed, run interactive onboarding + apply; else `ensureWorkspace`. (3) **Start daemon** — kill any running, spawn detached `claw-daemon start`, health-poll `/health` up to 60s. (Windows non-MSI) **build desktop app** + create Desktop/Start-Menu shortcuts; **install auto-start** (Startup-folder VBS). Print summary (Web UI `http://localhost:<port>`), open browser unless non-interactive.

**Relevant `bin/claw.ts` subcommands:** `version`, `daemon <...>`, `setup [--non-interactive]`, `update [...]`, `memory <...>`, `agents <...>`, `app`, `agency [...]`, `web`, `send <msg>`, and the default (TUI).

---

### F24 — Onboarding wizard

**Purpose.** Collect the minimal identity on first run.

**Behavior.** `needsOnboarding()` = `claw.json` absent OR no `agent_name`. `runOnboarding()` prompts: **agent name** (default `CLAW`), then **emoji** from 8 choices (🦀 default, plus Robot/Brain/Lightning/Crystal Ball/Shield/Fox/Octopus) or any pasted emoji (≤8 chars). **Model is fixed at `claude-sonnet-4.6` — not prompted.** `applyOnboarding()` runs `ensureWorkspace`, writes `agent_name`/`agent_emoji`/`model` (and sets all `sub_agent_models` to that model), enables a default heartbeat, writes a minimal USER.md (timezone auto-detected), substitutes the name into SOUL.md, and writes an initial daily log. The MSI variant (`first-run-setup.ps1` Step 5) asks the same two questions, pre-seeds `claw.json`, then runs `claw setup --non-interactive`. There is **no web-UI onboarding**; auth (gh/az) is handled by the setup scripts, not onboarding.

---

### F25 — Watchdog & auto-start

**Daemon auto-start on login (git/source, Windows).** Startup-folder VBS launcher `%APPDATA%\…\Startup\claw-daemon.vbs` running `cmd /c cd /d "<workdir>" && node "<daemon>" start` hidden. Chosen over Task Scheduler to avoid UAC.

**Restart watchdog (Windows).** Scheduled task **`Work-Claw Daemon Watchdog`**. Interval = `daemon.watchdog_interval_minutes` (default 2, clamped 1–60); skipped entirely if `daemon.watchdog_enabled === false`. Triggers: at-logon + repeating every interval. Runs hidden (`wscript.exe … daemon-watchdog.vbs` → `powershell -WindowStyle Hidden … daemon-watchdog.ps1`). The watchdog script health-checks `/health`, and if unhealthy kills the stuck daemon (by port owner and by `node.exe` whose command line contains `claw-daemon.js`) and relaunches it hidden. MSI installs use the same task (default interval 10 if config absent) and rely on its at-logon trigger (no Startup VBS).

**POSIX.** macOS LaunchAgent `com.workclaw.daemon-watchdog.plist` (`launchctl load -w`) or Linux systemd user timer `work-claw-watchdog.timer`, both honoring the same config.

---

### F26 — Update flow

**`update.ps1` (bootstrap updater).** Resolves config via `bootstrap.json` → `data_dir` → `claw.json` (`install_dir`, `remote_url`, `update_channel`). **Branch = explicit `-Branch`, else `update_channel` if not "stable", else `main`** (so "stable"→`main`; any other channel name IS the branch). Remote URL must be `https://` with no shell-metacharacters. Steps: clone `--depth 1 --single-branch --branch <branch>` (a **git clone**, not a release-tag download); verify `package.json` + `scripts/post-update.ps1`; stop desktop + daemon; swap dirs/files (`dist, node_modules, package.json, package-lock.json, src, scripts, installer, bin, tsconfig*, vitest.config.ts` + root docs); hand off to `scripts/post-update.ps1`. On any failure → roll back from backup, relink, restart, report rollback. `post-update.ps1` does `npm install` + `npm run build`, handles MSI-runtime layout (robocopy into `<root>\app`, `npm rebuild`, UAC self-elevation), relinks (git only), runs `claw setup`, reconciles the watchdog, relaunches the desktop app if it had been running.

---

### F27 — Uninstall flow

**`uninstall.ps1` (Windows).** Param `-KeepTunnel`. Steps: (1) stop daemon (`claw daemon stop`, fallback kill matching `node.exe`); (2) delete legacy scheduled task **`CLAW_Daemon`**; (3) `npm unlink -g claw`; (4) remove `claw.local` from the hosts file; (5) delete Desktop + Start-Menu `CLAW.lnk`; (6) unless `-KeepTunnel`, `devtunnel delete <tunnel_id> -f` (from `claw.json#tunnel.tunnel_id`); (7) `Remove-Item ~\.claw -Recurse -Force` (also takes `~/.claw/desktop`). The source repo is left untouched.

> **Known gap (flag for re-implementer).** `uninstall.ps1` removes only the **legacy** `CLAW_Daemon` task — it does **not** remove the current **`Work-Claw Daemon Watchdog`** scheduled task or the **`claw-daemon.vbs`** Startup-folder launcher. After uninstall, those can persist. A complete uninstall must also delete the `Work-Claw Daemon Watchdog` task and the Startup-folder VBS.

---

## 4. Data & Formats Appendix

### 4.1 Complete `claw.json` schema

Every field present in `ClawConfig` (config.ts) and `DEFAULT_CONFIG` (defaults.ts). **Default** column shows the value in `DEFAULT_CONFIG` ("—" = optional, no default; absent from `DEFAULT_CONFIG`).

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `agent_name` | string | `"CLAW"` | Agent's name (identity block + SOUL substitution). |
| `agent_emoji` | string | `"🦀"` | Agent's emoji (identity block). |
| `model` | string | `"claude-sonnet-4.6"` | Default LLM model. Always required. |
| `background_model` | string? | `"gpt-5.4-mini"` | Lighter model for background work (heartbeat, extraction, memory maintenance). |
| `reasoning_effort` | `"low"\|"medium"\|"high"\|"xhigh"`? | — | Global reasoning effort → SDK `reasoningEffort`. Omitted → SDK default. |
| `reasoning_summary` | `"none"\|"concise"\|"detailed"`? | — | Reasoning-summary verbosity. |
| `context_tier` | `"default"\|"long_context"`? | — | Context window tier. |
| `large_output` | object? | `{ enabled:true, max_size_bytes:51200 }` | Spill large tool outputs to files. Fields: `enabled?`, `max_size_bytes?`, `output_directory?`. |
| `workspace` | string | `"~/.claw"` | Nominal workspace path (actual dir resolved via `bootstrap.json`/env). |
| `sub_agent_models` | `Record<string,string>` | `{}` | Per-role model overrides for sub-agents. |
| `infinite_sessions` | boolean | `true` | Auto-continue sessions past context limits. |
| `daemon` | object? | `{ watchdog_interval_minutes:2, watchdog_enabled:true }` | Daemon security/runtime. Fields: `allow_remote_dangerous_actions?`, `attachments?{max_size_mb?(5), max_per_message?(5)}`, `rich_artifacts?{audio_roots?}`, `watchdog_interval_minutes?(default 10 in code / 2 in DEFAULT_CONFIG, 1–60)`, `watchdog_enabled?(true)`. |
| `escalation` | object | `{ default:"ask", high_complexity:"ask", low_complexity:"attempt", log_all_actions:true }` | Only `default` is read (F14). |
| `heartbeat` | object | `{ enabled:true, interval_minutes:15, actions:[…] }` | Background heartbeat. `actions` default = `daily_checkin, reflect_and_learn, memory_maintenance, memory_size_check, stale_task_check, work_open_tasks, cleanup_workspace, skill_evolution, monitor_tasks, growth_digest, agency_marketplace_sync, agency_mcp_refresh, agency_catalog_refresh`. |
| `theme` | object | `{ primary_color:"#FF6B35", accent_color:"#4ECDC4" }` | UI theme. |
| `prompt_color` | string? | `"red"` | CLI border/cursor color (named or hex). |
| `history_limit` | number? | `100` | Max in-memory command history entries (1–10000). |
| `persist_history` | boolean? | `false` | Persist command history (plaintext) to `command-history.json`. |
| `autoDownloadUpdates` | boolean? | `true` | Reconciled with `auto_update.enabled`. |
| `update_channel` | string | `"main"` | Update branch/channel ("stable"→`main`; else the branch name). |
| `auto_update` | object | `{ enabled:true, check_interval_hours:2 }` | Auto-update. |
| `tunnel` | object? | — | Dev Tunnels remote access. Fields: `enabled`, `tunnel_id?`, `auth_provider?("github"\|"microsoft")`, `anonymous_check_interval_minutes?(15)`, `allowed_origins?[]`. |
| `memory_limits` | `Record<string,number>`? | — | Per-file memory size caps (bytes). |
| `knowledge_base` | `{ path }`? | — | External KB (Obsidian vault) replacing built-in structured memory in the prompt. |
| `install_dir` | string? | — | Git repo root where CLAW is installed (API-immutable). |
| `remote_url` | string? | — | Git remote for update scripts (API-immutable). |
| `developer_mode` | boolean? | — | Show advanced update options (branch selector). |
| `world_enabled` | boolean? | `false` | Experimental 16-bit Agent World visualizer. |
| `auth` | object | `{ emu_org:"microsoft", require_emu:true }` | GitHub EMU enforcement. |
| `plugins` | object? | `{ enabled:false, modules:[] }` | Route-only startup plugins (explicit modules; no discovery). |
| `agency` | object? | `{ enabled:true, marketplace:"curated", sync_interval_hours:24, gallery_enabled:true }` | Microsoft Agency CLI (MCP/marketplace only). Also: `catalog_root?`, `catalog_marketplace?("playground")`, `catalog_repo_url?`, `catalog_auto_refresh?(true)`, `catalog_refresh_interval_hours?(24)`. |
| `audio_synthesis` | object? | `{ enabled:false, provider:{kind:"disabled"} }` | Local-only audio synthesis. `provider` = `{kind:"disabled"}` or `{kind:"local-command", command?, args?, voice?, stylePreset?, outputExtension?}`. |
| `completion_notifications` | object? | (see below) | Away-only completion notifications. |
| `comm_channels` | object? | — | Email/Teams self-chat integration (see below). |
| `provider` | object? | — | **SPECIFIED-BUT-UNIMPLEMENTED** BYOK (F13). API-immutable. |

`completion_notifications` default: `{ enabled:false, only_when_away:true, include_snippet:true, include_deep_link:true, idle_threshold_ms:30000, offline_threshold_ms:120000, min_interval_ms:300000, smart_summary:true, email:{enabled:false}, teams:{enabled:false} }`. `teams` extra fields: `destination?("self"\|"dm")`, `user_id?`, `notifier?("self"\|"flowbot")`, `flow_url?`, `token_mode?("az")`.

`comm_channels.email`: `{ enabled, smtp_address?, subject_filter?, require_subject_filter, poll_interval_seconds, reply_inline, reply_format("html"\|"plain"), max_body_length, max_replies_per_hour?(60, 1–1000) }`.
`comm_channels.teams`: `{ enabled, poll_interval_seconds, reply_inline, max_message_length, max_replies_per_hour?(120, 1–1000), activation?{mode?("always"\|"prefix"), phrases?, strip_trigger?, case_sensitive?}, progress_updates?{mode?("off"\|"single_ack"), first_after_seconds?}, diagnostics?{activity_log_enabled?, include_previews?} }`.

**Example `claw.json`:**
```json
{
  "agent_name": "Ada",
  "agent_emoji": "🦊",
  "model": "claude-sonnet-4.6",
  "background_model": "gpt-5.4-mini",
  "reasoning_effort": "medium",
  "workspace": "~/.claw",
  "sub_agent_models": {},
  "infinite_sessions": true,
  "escalation": { "default": "ask", "high_complexity": "ask", "low_complexity": "attempt", "log_all_actions": true },
  "heartbeat": { "enabled": true, "interval_minutes": 15, "actions": ["daily_checkin", "reflect_and_learn"] },
  "theme": { "primary_color": "#FF6B35", "accent_color": "#4ECDC4" },
  "prompt_color": "cyan",
  "history_limit": 100,
  "persist_history": false,
  "update_channel": "main",
  "auto_update": { "enabled": true, "check_interval_hours": 2 },
  "auth": { "emu_org": "microsoft", "require_emu": true },
  "plugins": { "enabled": false, "modules": [] },
  "agency": { "enabled": true, "marketplace": "curated", "sync_interval_hours": 24, "gallery_enabled": true }
}
```

### 4.2 `Channel` schema (`channels.json`)

`channels.json` = `{ "channels": Channel[], "activeChannelId": string }`.

| Field | Type | Required | Default (on create) | Notes |
|-------|------|----------|---------------------|-------|
| `id` | string | yes | slug of `name` | == session name → `sessions/{id}.json`. |
| `name` | string | yes | — | Display name. |
| `emoji` | string | yes | `"#️⃣"` | Channel icon. |
| `description` | string | yes | `""` | — |
| `pinned` | boolean | yes | `false` | Pinned to top. |
| `hidden` | boolean | yes | `false` | Hidden from list. |
| `createdAt` | string (ISO) | yes | now | — |
| `lastActiveAt` | string (ISO) | yes | now | Updated on activity. |
| `unreadCount` | number | yes | `0` | — |
| `systemPromptOverlay` | string? | no | — | Extra prompt text (set for comm channels). |
| `availableTools` | string[]? | no | — | Tool allowlist (F9). |
| `excludedTools` | string[]? | no | — | Tool blocklist (ignored if allowlist set). |
| `squad` | SquadConfig? | no | — | Squad metadata. |
| `model` | string? | no | — | Per-channel model override (F10). |
| `reasoningEffort` | `"low"\|"medium"\|"high"\|"xhigh"`? | no | — | Per-channel reasoning override (F10). |

`SquadConfig` = `{ enabled, name, roster: {agent,role}[], autonomy:"supervised"|"semi-autonomous"|"autonomous", repo?, leadAgent?, maxConcurrentAgents?(3), createdAt, updatedAt }`. Reserved IDs: `general`, `email`, `teams`.

**Example channel:**
```json
{
  "id": "infra-oncall",
  "name": "Infra Oncall",
  "emoji": "🚨",
  "description": "Incident response context",
  "pinned": true,
  "hidden": false,
  "createdAt": "2026-06-25T09:00:00.000Z",
  "lastActiveAt": "2026-06-25T09:00:00.000Z",
  "unreadCount": 0,
  "availableTools": ["memory_read", "memory_write", "web_search"],
  "model": "claude-opus-4.1",
  "reasoningEffort": "high"
}
```

### 4.3 `provider` schema (BYOK — documented, unimplemented)

`provider = { type:"openai"|"azure"|"anthropic"(default "openai"), baseUrl:string(required), apiKey?:string, bearerToken?:string }`. Rules (documented): `baseUrl` required; `bearerToken` > `apiKey`; `model` required and must match provider's identifier. **Inert at HEAD** (F13).

### 4.4 `~/.claw/` workspace tree

Precious content under `data_dir` (== runtime dir unless `bootstrap.json` redirects). Runtime/transient content always under runtime dir.

```
~/.claw/                          (runtime dir; data_dir if no redirect)
├── bootstrap.json                { data_dir? }              [runtime]
├── claw.json                     main config                [data]
├── channels.json                 channels + activeChannelId [data] (lazy)
├── permissions.json              PermissionStore            [data]
├── tools.json                    MCP servers + overrides    [data]
├── structured.json               structured memory          [data]
├── SOUL.md / AGENTS.md / USER.md / MEMORY.md / TASKS.md / BOOT.md   [data]
├── SCHEDULES.md / schedules.json / tasks.json / pins.json   [data]
├── command-history.json          (if persist_history)       [data]
├── usage.db (+ -shm/-wal)        usage stats                [data]
├── audit.log                     append-only audit          [runtime]
├── daemon.log / daemon.pid / daemon.json                    [runtime]
├── memory/                       daily logs, topics/, index.db, inbox/, archive/   [data]
├── sessions/                     {channelId}.json, channels/, ephemeral/, archive/ [data]
├── agents/                       custom + built-in skill-agent .md files  [data]
├── skills/<agent>/               per-agent skill memory + scripts         [data]
├── artifacts/                    rich artifacts             [data]
├── scripts/                      copied update.ps1/setup.ps1 [data]
├── comm-channels/<channel>/      poller state               [data]
├── desktop/                      built claw-desktop.exe (Windows) [data]
├── logs/ (+ archive/)            rotated logs               [runtime]
└── tmp/                          stray-file quarantine      [runtime]
```

`ensureWorkspace` creates the root + `memory/`, `sessions/`, `skills/`, `agents/`, `tmp/`, the 6 default soul files, `claw.json`, `structured.json`, and `tools.json`. Copilot SDK session state lives separately under `~/.copilot/session-state/`.

### 4.5 `permissions.json` schema (`PermissionStore`)

```
{
  autonomyLevel: 0..4,                 // default 2 (Balanced)
  rules: PolicyRule[],                 // user-defined + learned
  trustPatterns: TrustPattern[],
  agentProfiles: AgentTrustProfile[],  // per-agent trustScore, allowedCategories, autonomyOverride
  auditLog: PermissionAuditEntry[],    // rolling, last 1000
  version: number
}
```
`PermissionAuditEntry = { timestamp, toolName, category, decision, actor, channelId?, ruleId, description, approvalDurationMs?, toolArgs?, riskScore?, approvalType? }`. Levels: 0 Strict, 1 Supervised, 2 Balanced (default), 3 Autonomous, 4 YOLO. Categories (14): file_read, file_write, shell_read, shell_write, git_read, git_write, external, mcp_tool, docker, memory, agent_spawn, agent_lifecycle, system_config, destructive. Decisions: allow, deny, ask, audit_only.

### 4.6 `audit.log` line format

Append-only, UTF-8, one line per action, **tab-separated**, no header:
```
<ISO-8601 timestamp>\t<actor>\t<action>\t<detail>\n
```
- `timestamp` — `new Date().toISOString()` (e.g. `2026-06-25T14:03:22.114Z`).
- `actor` — event class / agent name. Known values from hooks: `tool_pre`, `tool`, `error`, `session`, `permission`, plus API-router actors.
- `action` — for `tool`/`tool_pre`: the tool name; for `error`: the error context; for session: start/end marker.
- `detail` — free text. For `tool`: `"<status> | args: <first 200 chars of JSON.stringify(args)>"` where status is `"success"` else the SDK `resultType`. For `error`: the error message.

Example lines:
```
2026-06-25T14:03:22.114Z	tool_pre	shell	{"command":"git status"}
2026-06-25T14:03:22.880Z	tool	shell	ok | args: {"command":"git status"}
2026-06-25T14:05:01.002Z	error	tool:web_fetch	ETIMEDOUT
2026-06-25T14:05:10.500Z	permission	web_fetch	ask → allow
```

---

## 5. Coverage Notes

**Fully verified against source at HEAD:**
- Complete `claw.json` schema (every field in `ClawConfig` + `DEFAULT_CONFIG`), loader deep-merge semantics, API forbidden-keys and redaction.
- Soul files, defaults, first-run detection, workspace bootstrap, data-dir indirection.
- System-prompt assembly order, XML fences, daily-log channel filtering, context-budget table and truncation strategies.
- Channel schema, storage, reserved IDs, ID slugging, CRUD endpoints, override validation, per-channel tool filtering (conditional-spread mechanism), per-channel model/reasoning precedence and live-apply.
- PermissionEngine levels/categories/matrix/pipeline, `permissions.json` schema, live approval round-trip, audit-log format (both sinks), post-tool-use/error hooks, permissions REST API.
- Desktop app (mutex, port, tray, close-to-tray, WebView2, daemon start), `claw app`, install/setup/update/uninstall scripts, onboarding, watchdog/auto-start.

**Gaps / caveats a re-implementer must heed:**
1. **BYOK `provider` (F13) is documented-but-inert.** No parsing/validation/transport wiring exists. The precedence rules (baseUrl required, bearerToken > apiKey, model required+matching) are spec-only. Decide whether to implement the contract or replicate the inert behavior.
2. **`escalation.high_complexity`/`low_complexity`/`log_all_actions` (F14) are never read.** Only `escalation.default` gates the secondary SDK handler. The real authorization is the PermissionEngine. Audit logging is unconditional.
3. **The "allowlist beats blocklist" precedence (F9) lives in the GitHub Copilot SDK**, not this repo. A from-scratch transport must re-implement it.
4. **Uninstall gap (F27):** `uninstall.ps1` removes only the legacy `CLAW_Daemon` task, not the current `Work-Claw Daemon Watchdog` task or the `claw-daemon.vbs` Startup launcher.
5. **`daemon.watchdog_interval_minutes` default differs by source:** `2` in `DEFAULT_CONFIG`, but the MSI watchdog registration uses `10` when config is absent. Both clamp to 1–60.
6. **SDK-owned formats** (the exact session-create option shapes, `onPreToolUse`/`onPostToolUse` hook input types, `permissionDecision` return shapes) are part of the `@github/copilot-sdk` contract and are described here behaviorally, not by their TypeScript signatures.
7. Squad subsystem, heartbeat actions, comm-channel pollers, and the memory/topic-graph internals are referenced where they intersect this scope but are owned by other specs; only their config surface and channel/prompt touch-points are captured here.
