# Functional Specification — CLI, Terminal UI, Slash Commands & First-Run Onboarding

## 1. Overview

Work-CLAW ("CLAW") presents itself through two front-end binaries: `claw` (the user-facing CLI and terminal UI) and `claw-daemon` (the background server lifecycle manager). The `claw` binary dispatches on its first argument: utility subcommands (`version`, `daemon`, `setup`, `update`, `memory ...`, `agents ...`, `app`, `web`, `send`, `agency`) run and exit; with no recognized subcommand it launches an interactive terminal UI (TUI). The TUI is a full-screen terminal chat client that connects to the daemon over a local WebSocket (`ws://127.0.0.1:<port>`, default port 3117) and shares conversation history with the browser-based Web UI because both clients talk to the same daemon-managed sessions/channels. Inside the TUI the user types chat messages or `/`-prefixed slash commands; commands either run locally (config/memory/help) or proxy to the daemon's REST API. On the very first launch (or whenever `~/.claw/claw.json` lacks an `agent_name`), a two-question readline onboarding wizard runs in the plain terminal before the TUI/daemon starts, writing the agent's name, emoji, model, and initial soul/memory files to `~/.claw/`.

---

## 2. Feature Inventory (checklist)

CLI subcommands (`claw`):
- [ ] `claw` (no args) — launch TUI
- [ ] `claw --session <name>` — launch TUI on a named session
- [ ] `claw --model <id>` — launch TUI with a model override
- [ ] `claw version` / `claw --version` — print version + commit SHA
- [ ] `claw send <message>` — one-shot streamed message to stdout
- [ ] `claw web` — open Web UI in browser
- [ ] `claw app` — launch native desktop app (Windows) / browser fallback
- [ ] `claw setup [--non-interactive]` — full install (prereqs + onboarding + daemon + auto-start)
- [ ] `claw update [--dev|--stable|--rollback]` — pull, rebuild, restart
- [ ] `claw daemon <start|stop|restart|status|install|uninstall>` — daemon lifecycle (delegated)
- [ ] `claw memory <compact|stats|search|facts-cleanup|cleanup>` — memory maintenance
- [ ] `claw agents <add-source|remove-source|sync|sources|list>` — community agents
- [ ] `claw agency [args...]` — pass-through to Microsoft Agency CLI

Daemon binary (`claw-daemon`):
- [ ] `claw-daemon <start|stop|restart|status|install|uninstall|version>`
- [ ] `claw-daemon start [--port <n>]`
- [ ] `claw-daemon tunnel <enable|disable|status|url>` (+ `--new`, `--github`, `--microsoft`)

First-run onboarding wizard:
- [ ] Two-question readline wizard (name, emoji)
- [ ] Writes `claw.json`, `SOUL.md`, `USER.md`, daily log; ensures workspace

TUI behaviors:
- [ ] Daemon auto-start + health wait on launch
- [ ] Streaming assistant responses + thinking spinner / render ticker
- [ ] Verbose toggle (tool/reasoning surfacing)
- [ ] Stop / interrupt (Esc while thinking)
- [ ] Sub-agent spawn/stream/complete indicators + active-agents sidebar
- [ ] Channel bar + channel switching (Ctrl+1–9, `/channel`)
- [ ] Squad status bar (when active channel is a squad)
- [ ] Health view toggle (Ctrl+G) for heartbeat/maintenance events
- [ ] Sidebar toggle (Tab)
- [ ] Scrollback (Page Up/Down, Ctrl+Home/End)
- [ ] Command history (Up/Down arrows; optional disk persistence)
- [ ] Configurable prompt color + blinking cursor
- [ ] Status bar (agent name/emoji/version, model, session, time, health unread)
- [ ] Update-available banner
- [ ] Auto-save of session transcripts (periodic + on exit)

Slash commands (run by typing full command + Enter):
- [ ] `/help`, `/quit` (`/exit`), `/clear`, `/verbose`
- [ ] `/model`, `/config`, `/config set`
- [ ] `/memory`, `/memory status`, `/memory search`, `/memory gc`, `/compact`
- [ ] `/tasks`, `/schedules`, `/schedule run`, `/schedule toggle`
- [ ] `/sessions`, `/session list|new|view`
- [ ] `/agents`, `/tools`, `/audit`, `/soul`, `/artifacts`
- [ ] `/edit soul|user|agents`
- [ ] `/channel` (`/ch`) list|switch|create|hide|show|<id>
- [ ] `/audio` (`/synthesize-audio`)
- [ ] `/agency`, `/plugins`
- [ ] `/export`

Configuration contracts:
- [ ] `~/.claw/claw.json` keys read/written by CLI (`prompt_color`, `history_limit`, `persist_history`, `agent_name`, `agent_emoji`, `model`)
- [ ] `~/.claw/command-history.json` (plaintext history when persisted)

---

## 3. Detailed Feature Entries

### 3.1 `claw` dispatch and global behavior

**Purpose.** Single entry binary that routes the first CLI argument to a subcommand handler or, by default, the TUI.

**Trigger / entry-point.** Process launch; `process.argv.slice(2)` parsed. `args[0]` is the command.

**Inputs.**
- `command` (string, the first arg). Recognized values (case-sensitive, exact match): `version`, `daemon`, `setup`, `update`, `memory`, `agents`, `app`, `agency`, `web`, `send`. Any other value (including none) falls through to the TUI launch.
- `--version` flag anywhere in args prints version and exits — **except** when `command === "agency"` (so `claw agency --version` passes through to the Agency CLI).

**Behavior (step-by-step).**
1. On non-Windows platforms, set `process.umask(0o077)` so files created are owner-only (best effort; Windows ignores umask).
2. If `command === "version"` OR (`--version` present AND command ≠ `agency`): print `CLAW v<version>` plus ` (<sha>)` when a commit SHA is known and ≠ `"unknown"`, then exit 0.
3. Else dispatch on the command (sections below). Recognized subcommands all `process.exit()` when done (except `agency` and `send`, which keep the process alive for a child/event loop).
4. If no subcommand matched: run onboarding if needed, ensure daemon running, parse `--session`/`--model`, launch the TUI.

**Output / effect.** Depends on subcommand. Fatal errors from `main()` print `Fatal error: <err>` to stderr and exit 1.

**Edge cases.** Subcommand matching is exact and case-sensitive; `claw Send` is treated as the TUI fallback (an unknown command → TUI). `--session`/`--model` are only honored on the TUI path; they are ignored by subcommands.

---

### 3.2 TUI launch (`claw`, `claw --session <name>`, `claw --model <id>`)

**Purpose.** Start the interactive terminal chat client.

**Trigger.** `claw` with no recognized subcommand.

**Inputs.**
| Param | Type | Required | Default | Validation |
|---|---|---|---|---|
| `--session <name>` | string | no | `"main"` | Free-form; used as channel/session name. Requires a following token or the flag is ignored. |
| `--model <id>` | string | no | (daemon's configured model) | Free-form; passed as `modelOverride`. Requires a following token or ignored. |

**Behavior.**
1. If onboarding is needed (`needsOnboarding()` true), run `runOnboarding()` then `applyOnboarding(result)`. Otherwise call `ensureWorkspace()` to make sure `~/.claw` dirs/files exist.
2. `ensureDaemonRunning()` — if no daemon is healthy, spawn `claw-daemon start` detached and poll `http://127.0.0.1:3117/health` for up to 60 s (first start can take 30–60 s). On timeout, throw an actionable error pointing at `~/.claw/daemon.log` and `~/.claw/daemon-startup.log`.
3. Parse args left-to-right for `--session`/`--model` (each consumes the next token).
4. Mount the TUI with `{ sessionName, modelOverride }`. The TUI connects to the daemon over WebSocket on session `sessionName`.

**Output / effect.** Full-screen TUI. On exit, `process.exit(0)` is forced after unmount so the shell prompt returns.

**Edge cases.** The model shown initially is `modelOverride || "claude-sonnet-4.6"` until the daemon's `connected` event supplies the real model. If the daemon is unreachable on the initial connect, the TUI shows an error in the status area (it does not crash); reconnect attempts only begin after at least one successful connect.

**Example.**
```
$ claw --session work --model gpt-5.1
[CLAW] Starting daemon...
[CLAW] Daemon started.
<full-screen TUI opens on channel "work">
```

---

### 3.3 `claw send <message>` (one-shot)

**Purpose.** Send a single message and stream the assistant reply to stdout, then exit — for scripting/automation.

**Trigger.** `claw send ...`.

**Inputs.**
- `message` (string, required) = all args after `send` joined with spaces. Empty → usage error.

**Behavior.**
1. If no message: print `Usage: claw send <message>` to stderr, exit 1.
2. `ensureDaemonRunning()` (auto-starts daemon if needed).
3. Open a WebSocket transport and `connect("main")` (always the `main` session/channel — not affected by `--session`).
4. Wire events: `chunk` → write text to stdout (no newline); `complete` → print a trailing newline, disconnect, exit 0; `error` → print `Error: <msg>` to stderr, disconnect, exit 1.
5. `sendMessage(message)` and keep the process alive on the event loop.

**Output / effect.** Streamed assistant text to stdout followed by a newline.

**Edge cases.** Only `main` is targeted. Tool calls / sub-agent activity are not surfaced (only `chunk`/`complete`/`error`). If the daemon never completes, the process stays alive (no client-side timeout on completion).

**Example.**
```
$ claw send "summarize my open PRs"
You have 3 open PRs: #215 (merged-ready), #213 …
$
```

---

### 3.4 `claw web`

**Purpose.** Open the Web UI in the default browser.

**Behavior.** `ensureDaemonRunning()` → `safeOpen("http://localhost:<port>")` → print `Opened CLAW web UI at http://localhost:<port>` → exit 0.

**Output.** Browser tab at the local daemon URL (default `http://localhost:3117`).

---

### 3.5 `claw app`

**Purpose.** Launch the native Windows desktop app (WebView2 shell); fall back to the browser elsewhere or on failure.

**Behavior.**
1. `ensureDaemonRunning()` → `{ port }`.
2. Non-Windows: `safeOpen("http://localhost:<port>")`, print `Opened CLAW web UI at …`, exit 0.
3. Windows: resolve desktop exe path = `<runtimeDir>/desktop/claw-desktop.exe`.
   - If missing: attempt to build it (`dotnet publish -c Release` of `tools/claw-desktop`, 120 s timeout), copy `publish/` output + `claw.ico` into `<workspace>/desktop`. On build failure, fall back to opening the browser and exit 0.
   - Launch the exe detached with `--port=<port>`, `windowsHide:false`; print `🦀 CLAW desktop app launched (port <port>)`; exit 0.

**Edge cases.** If the project source can't be found and the exe is missing, prints `❌ Desktop app project not found. Run 'claw setup' first.` and exits 1.

---

### 3.6 `claw setup [--non-interactive]`

**Purpose.** One-step install: prerequisites → onboarding → start daemon → (Windows) build desktop app + shortcuts → install auto-start → open browser.

**Inputs.** `--non-interactive` (flag). When present, onboarding uses defaults (`name="CLAW"`, `emoji="🦀"`, `model="claude-sonnet-4.6"`) and the final browser-open step is skipped.

**Behavior (steps printed to console).**
1. Persist `install_dir` (repo root) and `remote_url` (git origin) into `claw.json`; for git installs write `.claw-deploy-time` and copy `update.ps1`/`setup.ps1` into `~/.claw/scripts/`.
2. **Step 1 — Prerequisites:** verify Node ≥ 22; ensure `gh` CLI installed (auto-install via winget/brew/apt/dnf) and authenticated (`gh auth login` interactive if needed). Confirms Copilot SDK availability. On failure, print guidance and exit 1.
3. **Step 2 — Workspace:** run onboarding if needed (interactive, or defaults under `--non-interactive`), else `ensureWorkspace()`.
4. **Step 3 — Daemon:** start (or kill+restart) the daemon in the background; poll `/health` up to 60 s, printing `Waiting for daemon... (Ns)` every 5 s.
5. **Desktop app (Windows, non-MSI):** `dotnet publish` build; create Desktop + Start-Menu `.lnk` shortcuts.
6. **Auto-start (non-MSI):** install a startup-folder launcher (idempotent).
7. Print a summary block (Web UI URL, optional Remote/tunnel URL, TUI/browser/one-shot hints) and, unless non-interactive, open the browser.

**Output / effect.** Console progress + a final "Work-CLAW is ready!" banner; daemon running; auto-start installed; shortcuts created.

---

### 3.7 `claw update [--dev|--stable|--rollback]`

**Purpose.** Pull the latest version, rebuild, and restart via `claw setup`.

**Inputs.**
- `--dev` → channel `dev` (branch from `channelToBranch`); `--stable` → channel `stable`. A channel switch is persisted to `claw.json` (`update_channel`).
- `--rollback` → checkout the SHA saved in `.claw-pre-update-sha`, reinstall/build/link.

**Behavior (git-clone install).**
1. Stop daemon.
2. Save current `HEAD` SHA to `.claw-pre-update-sha`.
3. `git fetch/checkout/pull` the channel branch; `npm install`; `npm run build`; `npm link`.
4. Clear update-check cache; run `claw setup` to restart the daemon.
5. Print `Updated from v<old> → v<new> (channel: <channel>)`.

For npm-global installs, step 3 becomes `npm install -g git+<remote>#<branch>`.

**Edge cases.** Each git/npm step has a timeout; failures print a specific message and exit 1 (except `npm link`, which only warns). `--rollback` requires a saved SHA or it errors out.

---

### 3.8 `claw daemon <subcommand>` (delegation) and `claw-daemon`

**Purpose.** Manage the background daemon process.

**Behavior of `claw daemon ...`.** If `args[1] === "start"` and onboarding is needed, run onboarding first. Then locate `claw-daemon.js` next to the running script and `execFileSync(process.execPath, [daemonScript, ...subArgs])` with inherited stdio; exit 0 (or 1 on throw). I.e. `claw daemon X` is a thin wrapper around `claw-daemon X`.

**`claw-daemon` subcommands** (`args[0]`, default `start`):

| Subcommand | Behavior | Output |
|---|---|---|
| `start [--port <n>]` | Warm bootstrap, ensure workspace, set up file logging, import server (with better-sqlite3 native-binding self-heal/rebuild on ABI mismatch), `chdir` to `~/.claw/tmp`, clean stray root files, rotate logs, start HTTP+WS server on `--port` or 3117. | `[CLAW Daemon] v<v> starting on port <p>…` then runs in foreground. |
| `stop` | Prefer graceful HTTP `POST /api/shutdown` (saves sessions); wait up to ~5 s for exit; else `SIGTERM` the PID. Clears `daemon.json`. | `Graceful shutdown initiated` / `Not running.` |
| `restart` | `stop`, wait 1 s, then spawn a fresh detached `start` (passing through `--port`), using `install_dir` as cwd. | `[CLAW Daemon] Restarted in background.` |
| `status` | Report running state, PID, port, tunnel URL (if any), start time, and whether auto-start is installed. | Multi-line status block (see example). |
| `install` | Install OS auto-start launcher (uses `install_dir`). | Result string from installer. |
| `uninstall` | Remove auto-start launcher. | Result string. |
| `tunnel ...` | See 3.9. | — |
| `version` / `--version` | `CLAW Daemon v<v> (built: <BUILT_AT>)`. | One line. |
| (unknown) | `Usage: claw-daemon <start|stop|restart|status|install|uninstall|tunnel>` | exit 1. |

**Inputs.** `--port <n>` (integer; default 3117, or `CLAW_DAEMON_DEFAULT_PORT` env override) for `start`/`restart`.

**`claw daemon status` example.**
```
[CLAW Daemon] Running
  PID:        12345
  Port:       3117
  Tunnel:     https://abc-3117.usw2.devtunnels.ms
  Started:    2026-06-25T09:00:00.000Z
  Auto-start: installed
```

---

### 3.9 `claw-daemon tunnel <enable|disable|status|url>`

**Purpose.** Manage an Azure Dev Tunnel exposing the local daemon at a persistent public URL.

**Inputs / flags.** `enable [--new] [--github|--microsoft]`. `--microsoft` selects Microsoft Entra auth (default `github`). `--new` deletes any existing tunnel and creates a fresh one.

**Behavior.**
- `enable`: verify `devtunnel` CLI installed (else print winget install hint, exit 1); log in if needed; if a tunnel already exists and not `--new`, just re-enable + update auth provider in config; otherwise create a persistent tunnel for the daemon port and save `{ enabled, tunnel_id, auth_provider }` to `claw.json`. Prompt the user to restart the daemon to connect.
- `disable`: delete the remote tunnel, set `config.tunnel = { enabled:false }`, save.
- `status`: print enabled state, tunnel id, auth provider, and URL/connection status (reads `daemon.json` for the live `tunnelUrl`).
- `url`: print the live tunnel URL or exit 1 with `No tunnel URL available`.

**Output.** Status/usage text. The tunnel URL appears in `claw daemon status` once the daemon connects.

---

### 3.10 `claw memory <compact|stats|search|facts-cleanup|cleanup>`

**Purpose.** Command-line memory maintenance utilities (operate directly on `~/.claw` memory DB/files; do not require the TUI).

| Subcommand | Args | Behavior / Output |
|---|---|---|
| `compact` | — | Drops legacy embedding tables, VACUUMs the index DB. Prints `✅ Memory compact complete (vacuumed=…)` plus dropped-row counts and any self-heal summary. |
| `stats` | — | Prints a read-only recall-telemetry report. |
| `search <query…>` | query terms | Keyword-first deep recall; prints the formatted report. |
| `facts-cleanup [--apply]` | `--apply` | Dry-run by default: prints duplicate fact group/row/topic counts and a hint to run with `--apply`. With `--apply`: obsoletes duplicate DB rows and prints a completion summary. |
| `cleanup [--apply]` | `--apply` | Dry-run by default: reports topic files to merge, markdown/DB duplicates, topics affected. With `--apply`: makes a backup first, then merges/dedups, printing the backup path. |

**Edge cases.** On failure each prints `❌ <error>` to stderr and exits 1.

---

### 3.11 `claw agents <add-source|remove-source|sync|sources|list>`

**Purpose.** Manage community/custom sub-agent definitions sourced from git repos.

| Subcommand | Args | Behavior |
|---|---|---|
| `add-source <repo-url>` | url (required) | Prints a trust warning, registers the source. Missing url → usage + exit 1. |
| `remove-source <repo-url>` | url (required) | Removes the source (exit 1 if not found). |
| `sync` | — | Fetches agents from all configured sources; prints synced names / errors / "no sources" hint. |
| `sources` | — | Lists configured sources with name, url, added date. |
| `list` | — | Lists local agents (`📁`) and community agents (`🌐`, grouped by org/team) with emoji, name, description. |
| (none/unknown) | — | Prints usage for the five subcommands, exit 0. |

---

### 3.12 `claw agency [args...]`

**Purpose.** Transparent pass-through to the detected Microsoft Agency CLI binary.

**Behavior.** Detect the `agency` binary; if absent, print install instructions and exit 1. Otherwise `spawn(binPath, args.slice(1), { stdio: "inherit" })`; on child close, re-raise its signal or exit with its code. `--version` is **not** intercepted by `claw` for this command (it forwards).

---

### 3.13 First-Run Onboarding Wizard

**Purpose.** Collect the agent's name and emoji on first run; everything else is learned later. This is the readline (plain-terminal) wizard actually used — not the in-TUI `WelcomeScreen` component (which is unused dead code; see Coverage notes).

**Trigger / entry-point.** `needsOnboarding()` returns true when `~/.claw/claw.json` does not exist, OR exists but has no `agent_name` (or fails to parse). Invoked before: TUI launch, `claw daemon start`, and `claw setup`.

**Inputs / prompts (interactive, in order).**
1. Banner is printed (boxed `🦀 Welcome to Work-CLAW 🦀`).
2. Prompt: `What would you like to name your agent? [CLAW]: ` → trimmed answer; empty → `"CLAW"`.
3. Emoji picker. Suggested list (1-indexed): `🦀 Crab (default)`, `🤖 Robot`, `🧠 Brain`, `⚡ Lightning`, `🔮 Crystal Ball`, `🛡️ Shield`, `🦊 Fox`, `🐙 Octopus`. Prompt: `Choice [1] or paste emoji: `.
   - Empty → `🦀` (index 0).
   - A number `1..8` → the corresponding suggested emoji.
   - Anything else → the raw input, truncated to 8 characters (treated as a pasted custom emoji).
4. Prints `<emoji> <name> is ready!` and a friendly line.

**`applyOnboarding(result)` — files written / config effects.** `result = { agentName, agentEmoji, model: "claude-sonnet-4.6" }`.
1. `ensureWorkspace()` creates all `~/.claw/` directories and default files.
2. `claw.json`: set `agent_name`, `agent_emoji`, `model`; set every entry of `sub_agent_models` to the model; set `heartbeat = { enabled:true, interval_minutes:15, actions:["daily_checkin","reflect_and_learn","memory_maintenance","stale_task_check"] }`.
3. `USER.md`: replaced with a minimal template containing the detected IANA timezone and placeholder Work-Context/Preferences sections.
4. `SOUL.md`: identity sentences rewritten to embed the chosen name.
5. Daily log (today's `YYYY-MM-DD.md`): an "initialized" entry naming the agent, emoji, and model.
6. Prints `✅ <emoji> <name> is ready! Starting up…`.

**Output / effect.** A fully initialized `~/.claw/` workspace personalized with the chosen name/emoji and model `claude-sonnet-4.6`.

**Edge cases.** Default agent name is literally `CLAW`; default emoji `🦀`. Custom emoji/paste capped at 8 chars. The model is fixed (`claude-sonnet-4.6`) — there is no model question in the wizard. Under `claw setup --non-interactive`, the wizard is skipped and these same defaults are applied directly.

**Example.**
```
╔══════════════════════════════════════════════╗
║       🦀  Welcome to Work-CLAW  🦀          ║
║  Your personal AI assistant for work         ║
╚══════════════════════════════════════════════╝

Quick setup — just two questions!

What would you like to name your agent? [CLAW]: Jarvis

Pick an emoji (or type/paste any emoji):
  1. 🦀  Crab (default)
  2. 🤖  Robot
  …
  8. 🐙  Octopus
Choice [1] or paste emoji: 2

  🤖 Jarvis is ready!
  I'll get to know you as we work together.

✅ 🤖 Jarvis is ready! Starting up...
```

---

### 3.14 TUI — message send, streaming, and thinking indicator

**Purpose.** Send chat text to the daemon and render the streamed reply.

**Trigger.** User types a non-`/` message and presses Enter in the InputBar.

**Behavior.**
1. If the text starts with `/`, it is routed to slash-command handling instead (3.18).
2. Otherwise: append a `user` message; create an empty `assistant` placeholder; set thinking label to `Thinking...`.
3. Stream: each `chunk` event appends to the current assistant message. On `complete`, timing metadata is stored, the thinking label clears, stats refresh, and the session transcript is saved.
4. Reconnect handling: if the daemon emits a retry signal mid-response, a `⚡ Session reconnected, retrying...` system line is added and a new assistant placeholder is started (label `Reconnecting...`).
5. While `isThinking`, a 16 ms render ticker forces ~60 fps re-render so externally-arriving WS chunks/spinner frames are flushed (prevents a "frozen" UI).
6. On send error: a `⚠️ Error: <message>` system line is shown and thinking clears.

**Output / effect.** Live-updating assistant message. Each message header shows the prefix (`👤 You`, `<emoji> <name>`, `⚙️ System`, `🔧 Tool`, `<emoji> <role>` for sub-agents), an optional elapsed duration, and a 12-hour timestamp. Spinner shows while thinking.

**Edge cases.** Empty/whitespace-only input is ignored by the InputBar (not submitted).

---

### 3.15 TUI — verbose toggle

**Purpose.** Surface tool calls (and reasoning detail) inline.

**Trigger.** `/verbose` command (no key binding).

**Behavior.** Toggles a boolean. When ON, the message-send path passes a verbose callback that adds a `🔧 Tool` message (`<label>: <detail>`) for each tool call/verbose event; the status bar shows a `🔍` marker next to the model. Toggling prints `🔍 Verbose mode ON …` / `🔇 Verbose mode OFF …`.

---

### 3.16 TUI — stop / interrupt

**Purpose.** Cancel an in-flight assistant response.

**Trigger.** `Esc` key while the agent is thinking. (Two handlers cover both states: the global handler cancels when `session.isThinking`; the InputBar's Esc handler also calls `onCancel` while disabled/thinking.)

**Behavior.** Sends a `cancel` message to the daemon. On the resulting `cancelled` (scope `main`) event, thinking clears and the completion callback fires. While thinking, the InputBar shows `Thinking... Esc to interrupt`.

---

### 3.17 TUI — channels, squad status, health view, sidebar, scrollback

**Channels.** A channel bar lists visible (non-hidden) channels. Switching:
- `Ctrl+1`..`Ctrl+9` → switch to the Nth visible channel.
- `/channel switch <id>`, `/channel <id>`, or selecting in the bar.
On switch, the current channel's messages are saved, the view clears, the daemon switches the channel and returns that channel's history (partitioned into main vs health). A `Switched to #<id>` system line is added.

**Squad status bar.** When the active channel has `squad.enabled`, a compact bar renders above the chat: `🎯 <squadName> │ 👥 <N> agents <bar> <active> active │ … │ ⚡ <autonomy>` plus a roster summary line (first 5 members, `+N more`). Task summary metrics (running/total/done/blocked) render when present.

**Health view.** `Ctrl+G` toggles between chat and a Health view that shows heartbeat/maintenance events (timestamped). Heartbeat events arriving while in chat increment a `💚 N new` unread counter in the status bar; entering Health clears it. Heartbeats are de-duplicated across live broadcasts and persisted history by a composite key (kind + normalized timestamp + content).

**Sidebar.** `Tab` toggles a sidebar showing tasks, active sub-agents (with elapsed time), and memory/daily-log sizes.

**Scrollback keys.** `Page Up`/`Page Down` scroll by ~75% of the viewport; `Ctrl+Home` (or `Ctrl+A`/`Ctrl+ArrowUp`) jumps to oldest; `Ctrl+End` (or `Ctrl+E`/`Ctrl+ArrowDown`) jumps to newest. New messages while scrolled up keep the view anchored; `↑ N older messages` / `↓ N newer messages` indicators show when content is hidden. The visible window size adapts to terminal rows.

**Status bar.** Left: `<emoji> <name> v<version>`. Middle: `<model>` (+ `🔍` if verbose, + `[💚 HEALTH]` in health view). Right: `Session: <channel/session> | <HH:MM ap> | <💚 N new if any> | ^G=health/chat`. Border/text turns green in health view, red otherwise.

**Update banner.** When the daemon reports an available update, a yellow banner `🆕 CLAW v<new> available — run 'claw update' to upgrade` appears under the status bar.

---

### 3.18 TUI — slash command dispatch (general)

**Purpose.** Run `/`-prefixed commands.

**Trigger.** Any submitted input starting with `/`. The command is split on spaces; `parts[0]` lowercased is the command keyword. Unknown keywords → `Unknown command: <cmd>. Type /help for available commands.`

**Note on the command palette.** A slash-command palette component and a filtering hook exist, but the palette is never opened in the current build (`enterCommandMode` is never invoked; the palette's own keyboard navigation is not wired). In practice, commands are executed by typing the full command text and pressing Enter; `Esc` only closes the (never-shown) palette. See Coverage notes. (Per-command behaviors are in 3.19; the authoritative list/table is the appendix.)

---

### 3.19 Slash command behaviors (selected, load-bearing)

**`/config` (no subcommand).** Prints a panel: `<emoji>  <name>`, heartbeat status, escalation default, then a `── /config set ──` block listing current `name`, `emoji`, `model`, `prompt_color` (default `red`), `history_limit` (default `100`), `persist_history` (default `false`). Reads via daemon `GET /api/config`.

**`/config set <key> <value>`.** Allowed keys and validation:
| Key (alias) | Config field | Value format / validation |
|---|---|---|
| `emoji` | `agent_emoji` | Any string, truncated to 8 chars. |
| `name` | `agent_name` | Any string, truncated to 32 chars. |
| `model` | `model` | Must match `^[a-z0-9._-]+$` (case-insensitive); else `⚠️ Invalid model name`. |
| `prompt_color` | `prompt_color` | A named color (resolved from a built-in map of ~50 names → hex), a 6-digit hex `#rrggbb`, or a 3-digit hex `#rgb` (expanded). Unknown names trigger a Levenshtein "did you mean" suggestion. Stored as a hex string. |
| `history_limit` | `history_limit` | Integer string only; must be `1 ≤ n ≤ 10000`; else `⚠️ history_limit must be a number between 1 and 10000`. |
| `persist_history` | `persist_history` | `true`/`false`/`on`/`off` (case-insensitive); stored as boolean. Else `⚠️ persist_history must be true or false`. |

On success: `PUT /api/config` with the validated value; updates local TUI state for `history_limit`/`prompt_color`/`persist_history`; prints `✅ Updated <key> → <value>`. Missing value → usage line listing the six keys. Unknown key → `Unknown config key: <key>` + valid-keys list.

**`/model <name>`.** Switches the active model (sends `switch_model`), prints `Model switched to: <name>`. No arg → prints `Current model: <model>`.

**`/memory` family.** `/memory` → `Memory: <size> | Today's log: <size>` + hint. `/memory status` → full health report (per-file sizes vs limits, archive counts, GC summary). `/memory search <q>` → ranked results as `<file>:<line> — <text>`. `/memory gc` → runs GC and prints the report. `/compact` → compacts oversized memory files + runs GC + prints size report.

**`/edit soul|user|agents`.** Resolves the target file path (`SOUL.md`/`USER.md`/`AGENTS.md`) and prints an instruction to run `<$EDITOR or notepad> <path>` (it does not spawn the editor itself).

**`/quit` / `/exit`.** Saves a daily-log entry + session transcript, prints `Goodbye! 🦀`, restores terminal, exits after ~500 ms.

(All other commands: see the appendix table 4.1 for syntax and effect.)

---

### 3.20 TUI — command history & prompt configuration (InputBar)

**Purpose.** Editable single-line prompt with recall and a configurable look.

**Inputs (from config).** `prompt_color` (default `red`), `historyLimit` (default 100), `persistHistory` (default false).

**Behavior.**
- Editing: insert/backspace/delete at cursor; `←/→`, `Home`/`Ctrl+A`, `End`/`Ctrl+E`. Cursor (`▋`) blinks every 500 ms; hidden while disabled.
- Border + cursor + prompt `> ` are rendered in `promptColor` (named or hex).
- History: `↑`/`↓` walk previously-submitted entries (a draft is preserved when navigating up from a fresh line). Each submitted line is appended; in-memory history is capped to `historyLimit`.
- Persistence: when `persist_history` is true, history is loaded from and saved to `~/.claw/command-history.json` (plaintext JSON array). Writes are serialized to avoid overlap. Changing only `historyLimit` trims in memory without re-reading disk.
- While thinking, the input shows `Thinking... Esc to interrupt` and is otherwise disabled for typing.

**Edge cases / security.** Persisted history is plaintext and may include secrets the user typed; it is opt-in. `historyLimit` outside 1–10000 is rejected at the `/config set` layer.

---

## 4. Data & Formats Appendix

### 4.1 Full slash-command table (authoritative — as registered in the palette command list and handled by the dispatcher)

| Command | Usage | Effect |
|---|---|---|
| `/model` | `/model <name>` | Switch active model; no arg prints current model. |
| `/memory` | `/memory` | Show memory size + today's log size. |
| `/memory status` | `/memory status` | Full memory health report (sizes, archives, GC). |
| `/memory search` | `/memory search <query>` | Ranked search across all memory tiers. |
| `/memory gc` | `/memory gc` | Run memory garbage collection + report. |
| `/tasks` | `/tasks` | Show TASKS.md contents. |
| `/schedules` | `/schedules` | List scheduled jobs with enabled state + last run. |
| `/schedule run` | `/schedule run <id>` | Trigger a job immediately (daemon API). |
| `/schedule toggle` | `/schedule toggle <id>` | Enable/disable a job. |
| `/sessions` | `/sessions [type]` | List sub-agent/scheduled/heartbeat sessions (optional type filter; first 20). |
| `/session list` | `/session list` | List saved chat sessions. |
| `/session new` | `/session new [name]` | Print restart hint `claw --session <name>`. |
| `/session view` | `/session view <id>` | Show a session transcript (truncated per message). |
| `/agents` | `/agents` | List agent types (emoji, name, role, model, [custom]). |
| `/config` | `/config` | Show current config panel. |
| `/config set` | `/config set <key> <value>` | Update config (keys: emoji, name, model, prompt_color, history_limit, persist_history). |
| `/audit` | `/audit` | Show last 15 audit log entries. |
| `/tools` | `/tools` | List tools with status badge, emoji, version, category, description. |
| `/agency` | `/agency` | Show Agency CLI integration status (binary, ring, wired MCPs, installed marketplace agents, compat warnings). |
| `/plugins` | `/plugins [query]` | Browse/search the Agency Plugin Gallery catalog (compat badges). |
| `/artifacts` | `/artifacts [date]` | List saved artifacts (optional date filter). |
| `/audio` (`/synthesize-audio`) | `/audio [text]` · `/audio --path <file>` | Generate an audio-first briefing from text, a local file, or the latest assistant response. |
| `/soul` | `/soul` | Show assembled SOUL.md content. |
| `/edit soul\|user\|agents` | `/edit <target>` | Print the `$EDITOR <path>` command for the target file. |
| `/channel` (`/ch`) | `/channel list\|switch <id>\|create <name>\|hide <id>\|show <id>\|<id>` | Channel management; bare `/channel <id>` switches if it exists. General channel cannot be hidden. |
| `/clear` | `/clear` | Clear the chat display (does not delete server history). |
| `/verbose` | `/verbose` | Toggle verbose/standard output. |
| `/compact` | `/compact` | Run full memory compaction + GC. |
| `/export` | `/export` | Render the current conversation to markdown (shown inline as a system message). |
| `/help` | `/help` | Print the built-in command list. |
| `/quit` (`/exit`) | `/quit` | Save + exit CLAW. |

Notes: `/synthesize-audio` is an alias of `/audio`; `/ch` is an alias of `/channel`; `/exit` is an alias of `/quit`. The README's "Slash Commands" table is a stale subset (missing `/audio`, `/agency`, `/plugins`, `/channel`, `/memory status`, `/memory gc`, `/schedule run|toggle`, `/session list|new`, `/compact`); use this table.

### 4.2 Full CLI / daemon command + flag table

| Binary | Command | Flags / args | Effect |
|---|---|---|---|
| `claw` | (default) | `--session <name>`, `--model <id>` | Launch TUI. |
| `claw` | `version` / `--version` | — | Print `CLAW v<v> (<sha>)`. |
| `claw` | `send` | `<message...>` (required) | One-shot streamed reply on session `main`. |
| `claw` | `web` | — | Open Web UI in browser. |
| `claw` | `app` | — | Launch desktop app (Win) / browser fallback. |
| `claw` | `setup` | `--non-interactive` | Full install flow. |
| `claw` | `update` | `--dev` \| `--stable` \| `--rollback` | Pull/rebuild/restart or roll back. |
| `claw` | `daemon` | `<start\|stop\|restart\|status\|install\|uninstall>` (+ `--port`, tunnel passthrough) | Delegates to `claw-daemon`. |
| `claw` | `memory` | `<compact\|stats\|search <q>\|facts-cleanup [--apply]\|cleanup [--apply]>` | Memory maintenance. |
| `claw` | `agents` | `<add-source <url>\|remove-source <url>\|sync\|sources\|list>` | Community agent mgmt. |
| `claw` | `agency` | `[args...]` | Pass-through to Agency CLI. |
| `claw-daemon` | `start` | `--port <n>` (default 3117 / `$CLAW_DAEMON_DEFAULT_PORT`) | Start server (foreground). |
| `claw-daemon` | `stop` | — | Graceful shutdown (HTTP) → SIGTERM. |
| `claw-daemon` | `restart` | `--port <n>` | Stop + detached restart. |
| `claw-daemon` | `status` | — | Running/PID/port/tunnel/started/auto-start. |
| `claw-daemon` | `install` / `uninstall` | — | Auto-start launcher on/off. |
| `claw-daemon` | `version` / `--version` | — | `CLAW Daemon v<v> (built: <BUILT_AT>)`. |
| `claw-daemon` | `tunnel` | `enable [--new] [--github\|--microsoft]` \| `disable` \| `status` \| `url` | Dev Tunnel mgmt. |

### 4.3 On-disk config contracts read/written by the CLI/TUI

`~/.claw/claw.json` (JSON object; defaults from `DEFAULT_CONFIG`). CLI/TUI-relevant keys:

| Key | Type | Default | Range / format | Written by |
|---|---|---|---|---|
| `agent_name` | string | `"CLAW"` | ≤ 32 chars via `/config set name` | onboarding, `/config set name` |
| `agent_emoji` | string | `"🦀"` | ≤ 8 chars | onboarding, `/config set emoji` |
| `model` | string | `"claude-sonnet-4.6"` | `^[a-z0-9._-]+$` | onboarding, `/config set model`, `/model`(runtime only) |
| `prompt_color` | string | `"red"` | named color or `#rgb`/`#rrggbb` (stored as hex) | `/config set prompt_color` |
| `history_limit` | number | `100` | integer 1–10000 | `/config set history_limit` |
| `persist_history` | boolean | `false` | true/false/on/off | `/config set persist_history` |
| `install_dir` | string | (unset) | abs path | `claw setup` |
| `remote_url` | string | (unset) | git URL | `claw setup` |
| `update_channel` | string | `"main"` | channel name | `claw update --dev/--stable` |
| `tunnel` | object | (unset) | `{ enabled, tunnel_id?, auth_provider? }` | `claw-daemon tunnel` |
| `heartbeat` | object | `{enabled, interval_minutes, actions[]}` | — | onboarding |

`~/.claw/command-history.json` — a plaintext JSON array of submitted command strings (newest last), capped to `history_limit`. Written only when `persist_history` is true. Path is `<dataDir>/command-history.json`.

`daemon.json` (in `~/.claw`) — written by the daemon; read by clients for `{ port, token, tunnelUrl, startedAt }`. The CLI/TUI authenticate to the WS/REST API using its `token` and connect on its `port`.

### 4.4 Connection / shared-history model

- The TUI opens a WebSocket to `ws://127.0.0.1:<port>` (port + bearer token from `daemon.json`), authenticates with `clientKind: "cli"`, then `connect` to a named session. The daemon replies `connected` with the model + full channel history; the client then requests the channel list.
- REST helpers (`GET/PUT /api/config`, `/api/sessions`, `/api/agents/types`, `/api/tools`, `/api/audit`, `/api/artifacts`, `/api/schedules/:id/run`, etc.) use the same token over `http://127.0.0.1:<port>`.
- Because the Web UI and TUI both connect to the same daemon sessions/channels, conversation history is shared between them; messages and channel switches broadcast to all connected clients in real time. Heartbeat/maintenance events are partitioned client-side into the Health view.
- Default daemon URL surfaced to users: `http://localhost:3117`.

---

## 5. Coverage Notes (unverified / caveats)

- **Slash-command palette is inert in this build.** `src/components/SlashCommandPalette.tsx` (with fuzzy filtering + arrow-key navigation) and `src/hooks/useSlashCommands.ts` (`enterCommandMode`, `moveUp`, `moveDown`, `setFilter`, `getSelectedCommand`) are defined, but `enterCommandMode` is never called anywhere in the TUI, and the palette component's own `useInput` navigation is not used. The palette therefore never renders; commands are run by typing the full command and pressing Enter. A re-implementer reproducing *external behavior* should treat the palette as not user-reachable. (Verified by grep: only `isCommandMode`/`exitCommandMode` are referenced in `app.tsx`.)
- **`WelcomeScreen` component is dead code.** `src/components/WelcomeScreen.tsx` implements a 5-step in-TUI wizard (name/callMe/workContext/helpWith/commStyle) but is not imported by the launch path (`src/index.tsx` mounts `App` directly). The real onboarding is the readline wizard in `src/onboarding.ts` (two questions). Spec 3.13 documents the real one.
- **Model default discrepancy with README.** README's example `claw.json` shows `"model": "claude-sonnet-4.5"`, but the verified default in `DEFAULT_CONFIG` and onboarding result is `claude-sonnet-4.6` (background model `gpt-5.4-mini`). The spec uses the source value.
- **Heartbeat actions discrepancy.** Onboarding writes a 4-action heartbeat list; `DEFAULT_CONFIG` defines a larger list (includes `memory_size_check`, `work_open_tasks`, `cleanup_workspace`, `skill_evolution`, `monitor_tasks`, `growth_digest`, `agency_*`). New installs via onboarding get the 4-action list; the broader set applies when defaults are used without onboarding overriding them. This is a memory/heartbeat-subsystem concern outside this CLI/TUI scope; documented only for accuracy.
- **`reasoning_effort` is not exposed via the CLI/TUI.** It exists in config (`/api/config`/Web UI Settings) but there is no `/config set reasoning_effort` and no CLI flag; it is out of scope here and only adjustable via the Web UI or by editing `claw.json`.
- **Default daemon port** is taken as 3117 throughout (overridable via `--port` or `CLAW_DAEMON_DEFAULT_PORT`). The exact derivation of the runtime/data directory (`~/.claw` vs a platform data dir) lives in `src/utils/paths.ts`/`bootstrap.ts` (not fully read); paths in this doc use the documented `~/.claw/...` convention, which matches README and the code's `getWorkspacePath`/`getDataDir` usage.
- **`/audio` availability** depends on a configured local audio-synthesis provider (`audio_synthesis` in config, disabled by default); the command exists and is reachable but will report a failure/disabled message unless a provider is configured. Provider wiring is outside CLI/TUI scope.
- **`claw daemon` vs `claw-daemon` flag parity** for `tunnel` is assumed to pass through unchanged (the `claw daemon` wrapper forwards all sub-args); the tunnel flags were verified against `claw-daemon` source only.
