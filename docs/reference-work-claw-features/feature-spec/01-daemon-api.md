# Daemon, HTTP/WebSocket Server, REST API, Auth, Rate Limiting, Route-Only Plugins, Dev Tunnels — Functional Spec

## What this subsystem is

A single long-lived background process (the "daemon") binds **one TCP port** on `127.0.0.1` and serves three coexisting surfaces on it: (1) an HTTP REST API under `/api/*` plus a `/health` probe and a static single-page web UI; (2) a WebSocket endpoint on the same port (HTTP upgrade) carrying a bidirectional JSON chat/control protocol between clients (CLI + browser UI) and named AI "sessions"; (3) lifecycle/management entry points invoked by a CLI (`start/stop/restart/status/install/uninstall` and `tunnel enable/disable/status/url`). Access is gated by a single random bearer token generated at first start and persisted to a state file; loopback callers and remote (dev-tunnel/reverse-proxy) callers are treated differently for several security decisions. The daemon also optionally exposes itself to the internet through an Azure Dev Tunnel child process, and can load explicit, config-named "route-only" plugin modules that contribute additional `/api/extensions/<pluginId>/...` REST routes.

The default port is **3117** (override via env `CLAW_DAEMON_DEFAULT_PORT`, used so a preview build can default to 3118 and not collide with prod). The server always listens on `127.0.0.1` only.

---

## Feature inventory checklist

Daemon lifecycle / process:
- [ ] Port binding with EADDRINUSE retry + exponential backoff (8 attempts, 500 ms base)
- [ ] Daemon CLI: `start` (with `--port`)
- [ ] Daemon CLI: `stop` (graceful via HTTP, SIGTERM fallback)
- [ ] Daemon CLI: `restart` (detached respawn)
- [ ] Daemon CLI: `status`
- [ ] Daemon CLI: `install` / `uninstall` (login auto-start)
- [ ] Daemon CLI: `version` / `--version`
- [ ] Daemon CLI: `tunnel enable|disable|status|url`

Auth & token:
- [ ] Token generation (32 random bytes → hex)
- [ ] Token storage (`daemon.json` in state dir, atomic + restrictive perms, legacy migration)
- [ ] Token validation (constant-time)
- [ ] Token transport (REST `Authorization: Bearer`, WS `auth` message, HTML injection)
- [ ] Loopback vs remote determination (`isLocalRequest`)
- [ ] `requireLocalOrOptIn` gating semantics

Rate limiting:
- [ ] Per-IP token bucket over all `/api/*` (2000 / 60 s) → 429

HTTP transport-level:
- [ ] CORS / allowed-origin handling + `OPTIONS` preflight
- [ ] `GET /health` (minimal vs authorized full)
- [ ] Static asset serving (`/assets/*`) + SPA fallback (`index.html` with token injection)
- [ ] Security headers (CSP, X-Frame-Options, etc.)

Early-handled REST routes (in HTTP handler, need server state):
- [ ] `POST /api/shutdown`
- [ ] `POST /api/emergency-stop`
- [ ] `POST /api/restart`
- [ ] `GET/POST /api/tunnel/{status,install-cli,login,enable,disable,restart}`

REST API (router) — every endpoint enumerated in the Data & Formats appendix table:
- [ ] Plugins inspection (`GET /api/plugins`)
- [ ] Config, permissions, channels, comm-channels, squad, agents, sessions, schedules, memory, tasks, pins, usage, artifacts, tools/MCP, agency/gallery/publish, skills, update, data-dir, audit, health, models
- [ ] Route-only plugin dispatch (`/api/extensions/<pluginId>/...`)
- [ ] Unmatched `/api/*` → 404; thrown handler → 413 (payload) / 500 (other)

WebSocket protocol:
- [ ] Connection + origin verification + per-IP cap (16) + frame-size cap
- [ ] Auth handshake (`auth` → `auth_ok`/`auth_fail`) + pre-auth byte budget
- [ ] Full client→server message catalog
- [ ] Full server→client message catalog + broadcast triggers
- [ ] Keepalive ping/pong (server 30 s ping, client `ping`/`pong`)
- [ ] Message serialization (per-channel FIFO chains; fast-path reads)

Route-only plugins:
- [ ] Manifest shape + `register()` / `registerRoute()` contract
- [ ] Plugin id validation + reserved ids
- [ ] Route path validation (must be under `/api/extensions/<id>/`)
- [ ] Load lifecycle (config-driven, serialized registration, error capture)
- [ ] `requiresLocal` semantics for plugin routes

Dev tunnels:
- [ ] CLI resolution / install / login
- [ ] Tunnel create / host / reconnect / anonymous-access detection
- [ ] Token injection suppression for anonymous tunnel visitors

---

## Detailed feature entries

### F1. Port binding with retry/backoff

- **Purpose:** Bind the chosen port reliably even when a previous daemon's socket lingers in TIME_WAIT (notably Windows ~30 s).
- **Trigger:** `DaemonServer.start()` after token generation, session-manager init, and config load.
- **Inputs:** port (int, default 3117 or `--port`); retry config `{ maxRetries: 8, baseDelayMs: 500 }`.
- **Behavior:** Attempt `listen(port, "127.0.0.1")`. On `EADDRINUSE` and attempts remain, wait `baseDelayMs * 2^(attempt-1)` ms and retry. Total backoff across 8 attempts ≈ 63.5 s. Non-`EADDRINUSE` errors or exhausted retries throw. A sentinel error handler stays attached during the loop so async re-emitted EADDRINUSE doesn't become an uncaught exception. `maxRetries < 1` throws `RangeError`.
- **Output-effect:** Server listening; if the OS assigned a different port (port 0 case), `this.port` is updated from the bound address. After bind succeeds: write PID file and persist `daemon.json`.
- **Edge cases:** If a daemon is already running on `this.port` (checked before token gen), `start()` throws `"CLAW daemon is already running"`.

### F2. Daemon CLI commands (`bin/claw-daemon.ts`)

- **Entry:** `claw-daemon <command> [args]`; default command when none given is `start`.
- **`start [--port N]`:** Warms bootstrap cache, ensures workspace, sets up file logging (`<workspace>/daemon.log`, with EPIPE-safe stdio tee), `chdir` to tmp dir, rotates logs, imports `DaemonServer` (with a one-shot better-sqlite3 native-binding auto-rebuild on ABI mismatch), constructs `new DaemonServer(port)`, registers SIGINT/SIGTERM → `server.stop(); exit(0)`, then `server.start()`. On start failure: log + `exit(1)`.
- **`stop`:** Loads `daemon.json`; if not running, prints "Not running." Otherwise prefers graceful HTTP: `POST http://127.0.0.1:<port>/api/shutdown` with `Authorization: Bearer <token>`. On 2xx, polls `process.kill(pid, 0)` up to 10× / 500 ms for exit, then clears `daemon.json`. If HTTP fails, falls back to `process.kill(pid, "SIGTERM")` (may lose unsaved work on Windows) and clears `daemon.json`.
- **`restart`:** Calls `stop`, waits 1000 ms, then `spawn(execPath, [scriptPath, "start", ...portArgs], { detached: true, stdio: "ignore", windowsHide: true, cwd: install_dir? })` and `child.unref()`. Prints "Restarted in background."
- **`status`:** Loads `daemon.json`, checks running + PID, checks auto-start task. Prints (running): `Running`, `PID`, `Port`, `Tunnel` (if `tunnelUrl` set), `Started`, `Auto-start: installed|not installed`. Else prints `Not running` + auto-start line.
- **`install` / `uninstall`:** Install/remove an OS login auto-start task pointing at the daemon script; print the result string.
- **`version` / `--version`:** Prints `CLAW Daemon v<version> (built: <BUILT_AT>)`.
- **Unknown command:** Prints usage and `exit(1)`.
- **`tunnel <sub>`:** See F18.

### F3. Auth token: generation, storage, validation

- **Generation:** `crypto.randomBytes(32).toString("hex")` → a 64-hex-char token, created on every `start()` (in-memory; persisted to `daemon.json` only after the port binds).
- **Storage file:** `daemon.json` in the OS state dir (Windows `%LOCALAPPDATA%\work-claw\`, macOS `~/Library/Application Support/work-claw/`, Linux `$XDG_STATE_HOME/work-claw/`). Shape: `{ token, port, pid?, startedAt?, tunnelUrl? }`. Written atomically via temp file + rename; on POSIX created mode `0o600`; on Windows ACL-restricted to the current user via `icacls`. A legacy `~/.claw/daemon.json` is transparently migrated once (best-effort; falls back to reading legacy on new-location read failure).
- **Validation (`validateToken(provided, expected)`):** returns false immediately if lengths differ; otherwise `crypto.timingSafeEqual` (constant-time).
- **REST transport:** Header `Authorization: Bearer <token>` (the `Bearer ` prefix is stripped case-insensitively). Missing/invalid → `401 { "error": "Unauthorized" }` (the early shutdown/restart/tunnel routes use the body capitalization `Unauthorized`; the router-level auth also uses `{ "error": "Unauthorized" }`).
- **WS transport:** First WS message must be `{ "type": "auth", "token": "..." }` (see F12).
- **HTML transport:** For loopback (or trusted external-tunnel / non-anonymous dev-tunnel) page loads, the token is injected into the served `index.html` as `window.__CLAW_TOKEN__` (see F11).

### F4. Loopback vs remote (`isLocalRequest`) and `requireLocalOrOptIn`

- **`isLocalRequest(req)`:** Returns **false** if either `x-forwarded-for` or `x-forwarded-host` header is present (assume proxied/remote). Otherwise returns true only if the socket `remoteAddress` is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`. Used for: `GET /api/plugins`, plugin `requiresLocal` routes, and as the first arm of `requireLocalOrOptIn`. It is also surfaced informationally in `/api/health` and tunnel status (`isLocal`) without gating.
- **`requireLocalOrOptIn(req, res, action)`:** Returns true if `isLocalRequest`. Else loads config; returns true if `config.daemon.allow_remote_dangerous_actions === true`. Otherwise writes `403 { "error": "Remote callers cannot perform '<action>'. Either invoke from the local machine, or set 'daemon.allow_remote_dangerous_actions: true' in claw.json (NOT recommended)." }` and returns false (caller must `return`). Note: plugin `requiresLocal` and `GET /api/plugins` use the **strict** `isLocalRequest` only — they do NOT honor `allow_remote_dangerous_actions`.

### F5. Rate limiting

- **Scope:** All `/api/*` requests (enforced in the HTTP handler **before** the early shutdown/restart/tunnel routes and before the router). The keying IP is `req.socket.remoteAddress` (the raw socket address; not the forwarded IP).
- **Limit:** Token bucket — max **2000** requests per **60 000 ms** window per IP. Authenticated requests still count.
- **Response on limit:** `429` with headers `Content-Type: application/json`, `Retry-After: 5`, body `{ "error": "Too Many Requests" }`.
- **GC:** When the bucket map exceeds 1000 keys, expired buckets are pruned opportunistically.

### F6. CORS, OPTIONS, allowed origins

- **Allowed origin (`isAllowedOrigin`)** is true for: any `http(s)://localhost` or `http(s)://127.0.0.1` (any port); an exact origin match against the active dev-tunnel URL; or an exact origin match against any `config.tunnel.allowed_origins` entry. Used for both the CORS `Access-Control-Allow-Origin` echo and WS origin verification.
- **Per response:** If request `Origin` is allowed, sets `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. Always sets `Access-Control-Allow-Methods: GET, PUT, POST, DELETE, OPTIONS` and `Access-Control-Allow-Headers: Content-Type, Authorization`.
- **`OPTIONS` (any path):** Responds `204` with no body (after CORS headers).

### F7. `GET /health`

- **Purpose:** Liveness/health probe with privilege-scoped detail.
- **Auth:** Optional. Reads `Authorization: Bearer`; authorized iff token present and `validateToken` passes.
- **Unauthorized response (200):** `{ "status": "ok", "sdkReady": <bool> }`.
- **Authorized response (200):** `{ "status": "ok", "sdkReady": <bool>, "pid": <int>, "uptime": <seconds float>, "deployTime": <number>, "sessions": [<string>...], "clients": <int>, "tunnelUrl"?: <string> }`.
- **Note:** This is distinct from `GET /api/health` (router; see appendix), which is token-required and returns version/branch/etc.

### F8. `POST /api/shutdown`

- **Auth:** Bearer; on missing/length-mismatch/invalid → `401 { "error": "Unauthorized" }`.
- **Success (200):** `{ "status": "shutting_down" }`, then performs graceful `stop()` (saves sessions, closes WS, removes PID) and `process.exit(0)` (exit 1 on stop error).

### F9. `POST /api/emergency-stop`

- **Auth:** Bearer → 401 on failure as above.
- **Behavior:** Returns `200 { "status": "restarting" }`, then aborts all agents, broadcasts `{ "type": "emergency_stop" }` to all clients, stops the server, and respawns a fresh daemon on the same port (direct spawn, launcher fallback), then exits.

### F10. `POST /api/restart`

- **Auth:** Bearer → 401 on failure.
- **Body (optional, ≤ 64 KB):** `{ "continuation"?: { "channel": <string>, "message": <string> } }`. Body over 64 KB → `413 { "error": "Payload too large" }`. Invalid/empty JSON is ignored (restart proceeds without continuation).
- **Behavior:** If a valid continuation is provided it is persisted (survives process death). Returns `200 { "status": "restarting", "continuation": <bool saved> }`, broadcasts `{ "type": "daemon_restart" }`, then after ~300 ms saves sessions, stops the server (releases port), spawns a new daemon (launcher fallback), and exits.

### F11. Static UI + SPA fallback + token injection

- **`/assets/<file>`:** Serves from the first existing web-dist candidate dir; cached in memory; MIME by extension (`.js`,`.css`,`.svg`,`.png`,`.ico`; else `application/octet-stream`). Missing → `404 "Not found"`.
- **Any other non-API path:** Serves `index.html` (SPA fallback). The cached HTML has a `<script>` injected before `</head>` setting `window.__CLAW_TOKEN__` and `window.__CLAW_EMOJI__`.
- **Token-injection decision (four cases):** (1) local request → inject token; (2) external tunnel (local socket + forwarded host/origin matching a `tunnel.allowed_origins` entry, e.g. cloudflared behind Cloudflare Access) → inject; (3) dev-tunnel running and **not** anonymous → inject; (4) dev-tunnel running and anonymous → inject empty string (strip token). When stripped, `window.__CLAW_TOKEN__` is `""`.
- **Security headers on HTML (200):** `Cache-Control: no-cache, no-store, must-revalidate`; `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self' data:`; `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`.
- **Fallback when web files missing:** A minimal inline placeholder HTML (200) with the same CSP/`X-Frame-Options`/`nosniff` headers.

### F12. WebSocket connection, origin verification, caps

- **Connection URL:** Same host+port as HTTP, via the standard WS upgrade (e.g. `ws://127.0.0.1:3117/`). No special path required.
- **`verifyClient` (pre-accept):** Computes effective remote IP. If ≥ **16** existing clients share that IP → reject `429 "Too many WebSocket connections from this address"`. If no `Origin` header: accept only if the socket is loopback, else reject `403 "Origin header required for non-loopback clients"`. If `Origin` present: accept iff `isAllowedOrigin(origin)`, else reject `403 "Forbidden origin"`.
- **Frame-size cap (`maxPayload`):** Derived from `daemon.attachments` (per-attachment size × per-message count, base64-inflated, + envelope headroom). Oversized frames are rejected by the WS layer.
- **Pre-auth byte budget:** Until a client authenticates, inbound bytes are summed; exceeding **8 KB** closes the socket with code **1008** ("Pre-auth byte limit exceeded").
- **Effective IP for the per-IP cap:** Defaults to socket address. Only when the socket is loopback AND the `Origin` matches a configured external tunnel origin will it trust `cf-connecting-ip` (preferred, validated) or a single-hop `x-forwarded-for` (validated); multi-hop XFF is ignored. All chosen values must be well-formed IPs (`net.isIP() !== 0`).

### F13. WebSocket auth handshake

- **Client sends:** `{ "type": "auth", "token": <string>, "clientKind"?: "cli" | "ui" }` (default kind "ui").
- **On valid token:** mark authenticated, send `{ "type": "auth_ok", "version"?: <string>, "commitSha"?: <string>, "deployTime"?: <number> }`. Then, if a newer installer is ready, also pushes a `system_message`.
- **On invalid token:** send `{ "type": "auth_fail", "reason": "Invalid token" }` and close with code **4001** ("Auth failed").
- **Any non-`auth` message before auth:** reply `{ "type": "auth_fail", "reason": "Not authenticated" }` (does not close).
- **Keepalive:** Server pings all clients every **30 s**; a client that didn't `pong` since the last ping is terminated. Client may also send `{ "type": "ping" }` and receives `{ "type": "pong" }`.

### F14. WebSocket message serialization model

- **Fast-path (bypass FIFO):** `switch_channel`, `list_channels`, `presence`, `ping` are handled immediately (pure reads / client-local state).
- **Serialized path:** All other messages are chained per-channel: key is `msg.channelId` when present, else `"__global__"`. Each new message awaits the prior promise on its chain. This lets a long AI round-trip on channel A not block channel B.

### F15. Route-only plugin module contract

- **Manifest:** `{ id: string, name?: string, version?: string, description?: string }`. `id` must match `^[a-z][a-z0-9-]{1,63}$`, must not be a reserved id (`admin, api, claw, config, core, daemon, extension, extensions, health, plugin, plugins, system`), and must be unique. Optional string fields must be strings if present.
- **Module shape:** `{ manifest, register(ctx): void | Promise<void> }`. A loaded module may expose this as its default export, a named `plugin` export, or be the module object itself (first valid wins).
- **`register(ctx)`:** receives `ctx.registerRoute(route)`. Calling `registerRoute` after `register()` has returned throws (`"... cannot register routes after register() has completed"`).
- **`RouteContribution`:** `{ method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", path: string, requiresLocal?: boolean, handler: (context) => void|Promise<void> }`.
- **Route path validation:** Must be absolute, non-empty, contain no query/fragment, no `\`, no `%2e/%2f/%5c`, no `//`, no `*`, no trailing slash (except root), no `.`/`..`/empty segments, and must start with `/api/extensions/<pluginId>/`. Duplicate `METHOD path` registration throws.
- **Handler context:** `{ pluginId, route: { pluginId, method, path, requiresLocal? }, req, res, url, helpers }`. `helpers = { json, isLocalRequest, readBody(req, maxBytes?), readBodyCapped(req, maxBytes) }`. The body cap is clamped: any requested cap is `min(floor(maxBytes), 262144)`; non-finite/≤0 → 262144. Plugin handlers can never exceed the 256 KB body cap. The handler owns the entire response wire format.

### F16. Plugin load lifecycle

- **Trigger:** `start()` calls the loader with `config.plugins` after origin seeding and before listen-side wiring of heartbeat/scheduler.
- **Config gate:** Only loads if `config.plugins.enabled === true`. If `plugins.modules` is absent/null → no-op. If `plugins.modules` is not an array → records a load error (`"plugins.modules must be an array of non-empty module specifier strings"`).
- **Loading:** Each specifier must be a non-empty string; each is dynamically imported and a plugin module extracted. Import/extract failures are captured per-module (sanitized) and do not stop later modules.
- **Registration:** Serialized through an internal promise queue. A module's manifest is registered first; each `registerRoute` validates and stores the route. A failure during a module's registration removes that plugin and all its routes (rollback) and records the error. Diagnostic messages are sanitized (redacts bearer tokens, key/secret patterns, long hex, and filesystem paths; truncated to 300 chars).

### F17. Plugin route dispatch (`/api/extensions/...`)

- **When:** Inside the router, after all built-in routes and immediately before the 404 fallthrough.
- **Match:** `pluginHost.matchRoute(method, pathname)` — method must be one of the 5 allowed; pathname must validate and start with `/api/extensions/`; lookup is an **exact** `Map` lookup on `"<METHOD> <normalized-path>"`. **There is no path-parameter matching** — only exact method+path matches a registered route.
- **No match:** dispatch returns false → router emits `404 { "error": "Not found" }`.
- **`requiresLocal` gate:** If the matched route has `requiresLocal === true` and `!isLocalRequest(req)` → `403 { "error": "This extension route is only available to local callers" }`. (Strict — ignores `allow_remote_dangerous_actions`.)
- **Invoke:** Calls `route.handler(context)`.
- **Handler throws `PayloadTooLargeError`:** rethrown → top-level router catch → `413 { "error": "<message>" }`.
- **Handler throws other:** logs sanitized warning; if no response was written → `500 { "error": "Plugin route handler failed" }`.
- **Handler returns without writing a response:** `500 { "error": "Plugin route handler completed without sending a response" }`.
- **Inspection:** `GET /api/plugins` (local-only): `403 { "error": "Plugin diagnostics are only available to local callers" }` for non-loopback; else `200` with diagnostics `{ pluginCount, routeCount, loadErrorCount, plugins: [{ id, name?, version?, routeCount }], routes: [{ pluginId, method, path, requiresLocal? }], loadErrors: [{ pluginId?, moduleSpecifier?, message, occurredAt }] }`. When no plugin host is present, returns the empty diagnostics `{ pluginCount:0, routeCount:0, loadErrorCount:0, plugins:[], routes:[], loadErrors:[] }`.

### F18. Dev tunnels (CLI + REST + lifecycle)

- **CLI (`claw-daemon tunnel <sub>`):**
  - `enable [--github|--microsoft] [--new]`: Verifies devtunnel CLI installed (else prints install hint + exit 1); resolves provider (default `github`); logs in if needed (interactive browser); if a `tunnel_id` exists and not `--new`, re-enables config and tells user to restart; with `--new`, deletes the old tunnel; else creates a new tunnel for the daemon port, saves config `{ enabled:true, tunnel_id, auth_provider }`, and tells the user to (re)start the daemon. (Note: the REST `enable` path forces provider `microsoft`/Entra; the CLI default is `github`.)
  - `disable`: Deletes the remote tunnel (best-effort), sets `config.tunnel = { enabled:false }`, tells user to restart if running.
  - `status`: Prints enabled state, tunnel id, auth provider, and URL/connection status.
  - `url`: Prints `daemon.json.tunnelUrl` or errors (`exit 1`) if none.
- **REST tunnel routes** (`/api/tunnel/*`, Bearer-required, 401 on failure) — handled in the HTTP handler because they need the live `TunnelManager`: `status` (GET), `install-cli` (POST), `login` (POST), `enable` (POST), `disable` (POST), `restart` (POST). See appendix for exact bodies. Unknown tunnel route → `404 { "error": "Not found" }`.
- **Tunnel hosting lifecycle (`TunnelManager`):** On `start()` (if `config.tunnel.enabled` + `tunnel_id`), spawns `devtunnel host <id>`, parses the `*.devtunnels.ms` URL from stdout (30 s timeout → resolves null but keeps trying), saves `tunnelUrl` to `daemon.json`, and kicks an anonymous-access check. On process close: detects auth errors and schedules a reconnect (auth failures retry every 5 min after verifying login; transient errors use exponential backoff 2 s→60 s). `stop()` kills the child, clears the URL, resets anonymous state to the safe default (treated anonymous until re-verified), and clears `daemon.json.tunnelUrl`.
- **Anonymous detection:** `devtunnel show <id> --json` ACL inspected for any "anonymous" entry; on any error, defaults to **anonymous=true** (safe — strips token). Cached, periodically refreshed (default 15 min, configurable via `tunnel.anonymous_check_interval_minutes`).
- **CLI resolution:** Probes a ranked list of candidate paths (PATH first, then `~/bin`, homebrew, `/usr/local/bin`, bundled path last, plus the WinGet Links dir on Windows), validating each via `--version` banner match; cached.

---

## Data & formats appendix

### A. Auth / transport invariants

- **Bearer token:** 64 hex chars. Header form `Authorization: Bearer <token>` (case-insensitive prefix). All `/api/*` (router) require it → `401 { "error": "Unauthorized" }` if absent/invalid. `/health` and `GET /api/health` differ (see below).
- **Body cap:** default 256 KB (`262144`). Over-cap reads throw `PayloadTooLargeError` → `413 { "error": "Request body too large (max <N> bytes)" }` at the router's top-level catch. Some endpoints use explicit higher caps (memory PUT, artifact POST/PUT: 1 MB).
- **Router top-level catch:** `PayloadTooLargeError` → `413 { "error": <message> }`; any other throw (including bare `JSON.parse` failures on routes without their own try/catch) → `500 { "error": <sanitized message> }` (paths in the message are replaced with `<path>`, truncated to 500 chars).
- **Unmatched `/api/*`:** `404 { "error": "Not found" }`.

### B. REST endpoint table

Status codes shown are the success code; error rows give exact code + body. "Gate" = `local` (`isLocalRequest` only), `opt-in` (`requireLocalOrOptIn`), or blank (token only).

Early-handled (HTTP handler, before router):

| Method | Path | Gate | Success | Notable errors |
|---|---|---|---|---|
| POST | `/api/shutdown` | token | 200 `{status:"shutting_down"}` | 401 `{error:"Unauthorized"}` |
| POST | `/api/emergency-stop` | token | 200 `{status:"restarting"}` | 401 |
| POST | `/api/restart` | token | 200 `{status:"restarting",continuation:<bool>}` | 401; 413 `{error:"Payload too large"}` (>64 KB) |
| GET | `/api/tunnel/status` | token | 200 `{cliInstalled,loggedIn,enabled,tunnelId,tunnelUrl,running,isLocal,isAnonymous,error}` | 401 |
| POST | `/api/tunnel/install-cli` | token | 200 `{installed,message?}` or `{installed,path}` | 401; 500 `{error}` |
| POST | `/api/tunnel/login` | token | 200 `{loggedIn,message?}` | 401; 500 `{error}` |
| POST | `/api/tunnel/enable` | token | 200 `{tunnelId,tunnelUrl:null,enabled:true,connecting:true}` | 401; 400 `{error:"Dev Tunnel CLI not installed..."}`; 400 `{error:"Not logged in..."}`; 500 `{error}` |
| POST | `/api/tunnel/disable` | token | 200 `{enabled:false}` | 401; 500 `{error}` |
| POST | `/api/tunnel/restart` | token | 200 `{tunnelUrl}` | 401; 500 `{error}` |
| (other) | `/api/tunnel/*` | token | — | 404 `{error:"Not found"}` |

Router routes (`Authorization: Bearer` required unless noted; 401 `{error:"Unauthorized"}` on failure):

| Method | Path | Gate | Success | Key validation / errors |
|---|---|---|---|---|
| GET | `/api/plugins` | local | 200 diagnostics | 403 `{error:"Plugin diagnostics are only available to local callers"}` |
| GET | `/api/config` | token | 200 redacted config | secrets masked `[REDACTED]` |
| PUT | `/api/config` | token | 200 redacted merged config | 400 `{error:"These config keys cannot be modified via the API: ...}"` for forbidden keys `install_dir,remote_url,update_channel,auto_update,autoDownloadUpdates,data_dir,provider`; restarts daemon if `model` changed |
| PUT | `/api/config/update-pipeline` | opt-in | 200 redacted config | only `autoDownloadUpdates` (boolean) allowed; 400 on extra keys / non-boolean / empty |
| GET | `/api/audio-synthesis/status` | token | 200 `{...status,setupPrompt}` | |
| GET | `/api/permissions` | token | 200 store (auditLog stripped, `auditLogCount` added) | |
| PUT | `/api/permissions` | token | 200 store | `autonomyLevel` must be int 0–4 else 400 |
| POST | `/api/permissions/rules` | token | 201 newRule | 400 invalid/missing category or decision; 400 pattern non-string/>256/invalid-regex |
| DELETE | `/api/permissions/rules/:id` | token | 200 `{deleted:<id>}` | 404 `{error:"Rule not found"}` |
| GET | `/api/permissions/trust-patterns` | token | 200 patterns | |
| POST | `/api/permissions/trust-patterns/:id/accept` | token | 200 `{accepted:<id>}` | 404 `{error:"Pattern not found"}` |
| DELETE | `/api/permissions/trust-patterns/:id` | token | 200 `{deleted:<id>}` | 404 `{error:"Trust pattern not found"}` |
| POST | `/api/permissions/trust-patterns/:id/revoke` | token | 200 `{revoked:<id>}` | 404 |
| GET | `/api/permissions/audit` | token | 200 entries | query `limit`(100),`offset`,`category`,`decision`,`minRisk`,`maxRisk` |
| GET | `/api/permissions/audit/count` | token | 200 counts | same query filters |
| GET | `/api/permissions/audit/stats` | token | 200 stats | |
| GET | `/api/permissions/agents` | token | 200 agentProfiles | |
| PUT | `/api/permissions/agents/:name` | token | 200 profile | `autonomyOverride` null or int 0–4; `allowedCategories` null or category[]; name ≤64; 404 if profile missing; audit-logged |
| PUT | `/api/permissions/agents/:name/dry-run` | token | 200 `{agentName,dryRun}` | name ≤64 |
| POST | `/api/permissions/agents/:name/reset-trust` | token | 200 `{reset:<name>}` | 404 |
| DELETE | `/api/permissions/agents/:name` | token | 200 `{deleted:<name>}` | 404 |
| POST | `/api/permissions/seed` | token | 200 `{profilesSeeded,patternsSeeded}` | |
| GET | `/api/channels` | token | 200 channels[] | |
| POST | `/api/channels` | token | 201 channel | 400 `{error:'A channel named "general" cannot be created'}`; 400 override-validation; 409 `{error:<msg>}` |
| GET | `/api/channels/:id` | token | 200 channel | 404 `{error:"Channel not found"}` |
| PUT | `/api/channels/:id` | token | 200 channel | 400 general→squad; 400 override-validation; 404; may broadcast model switch |
| DELETE | `/api/channels/:id` | token | 200 `{archived:<id>}` | 400 `{error:"Cannot archive this channel"}` |
| GET | `/api/channels/:id/history` | token | 200 `{channelId,messages}` | 500 if no sessionManager |
| POST | `/api/channels/:id/squad/init` | token | 201 channel | 400 general; 404; 409 already-squad; 400 invalid JSON; 500 on failure (rolls back) |
| DELETE | `/api/channels/:id/squad` | token | 200 channel | 404; 400 not-a-squad |
| GET | `/api/channels/:id/squad/dashboard` | token | 200 dashboard | 404; 400 not-a-squad |
| GET | `/api/channels/:id/squad/status` | token | 200 `{channelId,squad,stateOnDisk,decisions}` | 404; 400 not-a-squad |
| GET | `/api/comm-channels/prerequisites` | token | 200 `{email,teams}` checks | |
| GET | `/api/comm-channels/status` | token | 200 per-channel status | |
| POST | `/api/comm-channels/toggle` | token | 200 `{channel,enabled}` | 400 `{error:"channel must be 'email' or 'teams'"}` |
| POST | `/api/comm-channels/resume` | token | 200 `{channel,resumed:true}` | 400 channel |
| GET | `/api/comm-channels/incidents` | token | 200 `{incidents}` | `limit` clamped 1–200 (default 20) |
| GET | `/api/completion-notifications/status` | token | 200 `{enabled,onlyWhenAway,providers}` | |
| GET | `/api/agents/types` | token | 200 `{builtIn,custom}` | |
| GET | `/api/agents/active` | token | 200 `{agents:[...]}` | |
| POST | `/api/agents/active/:id/cancel` | token | 200 `{cancelled,agentId}` | 500 if no sessionManager |
| POST | `/api/agents/custom` | token | 201 `{created:<name>}` | 400 name/description/systemPrompt/model validation |
| GET | `/api/agents/custom/:name` | token | 200 def | 404 |
| PUT | `/api/agents/custom/:name` | token | 200 `{updated:<name>}` | 400 field validation; 404 |
| DELETE | `/api/agents/custom/:name` | token | 200 `{deleted:<name>}` | 409 if on a squad roster; 404 |
| PUT | `/api/agents/builtin/:name` | token | 200 `{updated,overridden:true}` | 404 not-builtin; 400 field validation |
| DELETE | `/api/agents/builtin/:name/override` | token | 200 `{reset:<name>}` | 404 not-builtin |
| GET | `/api/agents/community` | token | 200 `{agents,grouped}` | |
| GET/POST/DELETE | `/api/agents/community/sources` | token | GET 200 sources; POST 201 source; DELETE 200 `{removed}` | POST 400 on throw; DELETE 404 `{error:"Source not found"}` |
| POST | `/api/agents/community/sync` | token | 200 result | |
| POST | `/api/agents/community/enable` | token | 200 `{enabled:<name>}` | 400 invalid name |
| POST | `/api/agents/community/disable` | token | 200 `{disabled:<name>}` | 400 |
| GET | `/api/agents/community/enabled` | token | 200 name[] | |
| GET | `/api/sessions` | token | 200 log summaries[] | query `type` filter |
| GET | `/api/sessions/:name` | token | 200 log | 404 `{error:"Session not found"}` |
| GET | `/api/schedules` | token | 200 jobs[] | |
| POST | `/api/schedules` | opt-in (if `trigger`) | 201 job | |
| PUT | `/api/schedules/:id` | opt-in (if touches trigger) | 200 `{message}`/updated job | 404 `{error:"Job not found"}` |
| DELETE | `/api/schedules/:id` | token | 200 `{message}` | |
| POST | `/api/schedules/:id/run` | opt-in (if trigger) | 200 `{message}` | 503 `{error:"Scheduler not available"}` |
| POST | `/api/schedules/:id/review-run` | opt-in (if trigger) | 202/409/404/500 `{message,status}` | 503 no scheduler |
| GET | `/api/memory/files` | token | 200 files[] | |
| GET | `/api/memory/files/audit` | token | 200 page | `limit`(50,≤200),`offset`(≥0) |
| PUT | `/api/memory-limits` | token | 200 `{saved:true,memory_limits}` | 400 invalid JSON/key/value; values clamped ≤10,000,000 |
| GET | `/api/memory/search?q=` | token | 200 results[] | 400 `{error:"Missing ?q= parameter"}` |
| GET | `/api/memory/search/v2` | token | 200 `{searchMode,timing,total,results}` | 400 q/source_type/sort; 500 on failure |
| GET | `/api/memory/semantic-status` | token | 200 status | 500 |
| GET | `/api/memory/graph` | token | 200 graph | 500 |
| POST | `/api/memory/cleanup` | token | 200 result | 500 `{success:false,error}`; `apply` bool |
| GET | `/api/memory/*` | token | 200 `{file,content}` | 404 `{error:"File not found"}` |
| PUT | `/api/memory/*` | token | 200 `{file,saved:true,mode,result?}` | 413 (>1 MB); 400 mode/section/path |
| DELETE | `/api/memory/topics/:id` | token | 200 `{deleted,factsRemoved}` | 404 `{error:'Topic "<id>" not found.'}` |
| GET | `/api/memory/sources` | token | 200 sources | 500 `{error}` |
| POST | `/api/memory/sources/:id/status` | token | 200 `{ok:true}` | 400 `{error:"Invalid status"}`; 500 |
| POST | `/api/memory/sources/scan` | token | 200 `{detected,added}` | 500 |
| GET | `/api/tasks` | token | 200 tasks[] | `lane` validated |
| GET | `/api/tasks/board` | token | 200 `{...byStatus,byStatus,byLane}` | |
| GET | `/api/tasks/board/:channelId` | token | 200 board | |
| GET | `/api/tasks/archived` | token | 200 tasks[] | |
| GET | `/api/tasks/blocked-overdue` | token | 200 tasks[] | `days`(3) |
| GET/PUT | `/api/tasks/config` | token | 200 `{throttle,executing,queued,hasCapacity}` | |
| POST | `/api/tasks` | token | 201 task | 400 `{error:"title is required and must be non-empty"}` |
| PUT (legacy) | `/api/tasks` (TASKS.md write) | token | 410 deprecation | |
| GET | `/api/tasks/task-:id` | token | 200 task | 404 `{error:"Task not found"}` |
| PUT | `/api/tasks/task-:id` | token | 200 task | 404 |
| DELETE | `/api/tasks/task-:id` | token | 200 `{archived,_notice}` | 404 (archives, not deletes) |
| POST | `/api/tasks/task-:id/assign` | token | 200 task | 400 role; 404 |
| POST | `/api/tasks/task-:id/cancel` | token | 200 task | 404 |
| POST | `/api/tasks/task-:id/complete` | token | 200 task | 404 |
| POST | `/api/tasks/task-:id/retry` | token | 200 task | 404 |
| POST | `/api/tasks/task-:id/dismiss-reminder` | token | 200 task | 404 |
| POST | `/api/tasks/task-:id/move` | token | 200 task | 400 invalid JSON / `toStatus` / transition; 404 |
| GET/POST | `/api/tasks/task-:id/comments` | token | GET 200 comments; POST 201 comment | 400 invalid JSON/`body`; 404 |
| POST | `/api/tasks/task-:id/link` | token | 200 task | 400 type; 404 |
| GET | `/api/tasks/task-:id/timeline` | token | 200 timeline | 404 |
| POST | `/api/tasks/task-:id/archive` | token | 200 task | 404 not-found/not-terminal |
| POST | `/api/tasks/task-:id/unarchive` | token | 200 task | 404 |
| POST | `/api/tasks/task-:id/queue` | token | 200 task | 404 not-pending |
| GET | `/api/pins` | token | 200 pins[] | `folderId` filter |
| POST | `/api/pins` | token | 201 pin | 400 invalid JSON / missing fields |
| DELETE | `/api/pins/:id` | token | 200 `{deleted}` | 404 `{error:"Pin not found"}` |
| PUT | `/api/pins/:id/move` | token | 200 `{moved,toFolder}` | 400; 404 |
| GET | `/api/pins/folders` | token | 200 folders[] | |
| POST | `/api/pins/folders` | token | 201 folder | 400 name |
| DELETE | `/api/pins/folders/:id` | token | 200 `{deleted}` | 404 `{error:"Folder not found"}` |
| PUT | `/api/pins/folders/:id` | token | 200 `{renamed,newName}` | 400; 404 |
| GET | `/api/pins/check/:messageId` | token | 200 `{isPinned,pin}` | 400 `{error:"channelId query parameter required"}` |
| GET | `/api/usage/summary` | token | 200 summary | `from`(−30d),`to`(now),`channel`; 400 `{error:"Invalid timestamp format"}` |
| GET | `/api/usage/by-channel` / `by-model` / `by-agent-type` | token | 200 data | from/to |
| GET | `/api/usage/by-date` | token | 200 data | `granularity` day/week/month |
| GET | `/api/usage/recent` | token | 200 turns | `limit` 1–1000 (def 20) else 400 |
| POST | `/api/usage/backfill` | token | 200 result | |
| GET | `/api/artifacts` | token | 200 query result | filters: date,start_date,end_date,tag,source,source_type,search,group_recurring,offset,limit |
| POST | `/api/artifacts` | token | 201 meta | cap 1 MB → 413; 400 invalid JSON / title / content / tags / source_type |
| GET | `/api/artifacts/:id/content` | token | streamed content | 400 invalid id; 404 |
| GET | `/api/artifacts/:path/path` | token | 200 `{relativePath,absolutePath}` | 404 |
| GET | `/api/artifacts/:path` | token | 200 artifact | 404 |
| PUT | `/api/artifacts/:path` | token | 200 `{updated}` | cap 1 MB; 400 content; 404 |
| DELETE | `/api/artifacts/:path` | token | 200 `{deleted}` | 404 |
| GET | `/api/tools` | token | 200 tools[] | |
| POST | `/api/tools/:name/toggle` | token | 200 `{name,enabled}` | 404 `{error:"Tool not found or is built-in"}` |
| POST | `/api/tools/scan` | token | 200 tools[] | |
| GET | `/api/tools/mcp` | token | 200 mcp entries[] | |
| POST | `/api/tools/mcp` | opt-in | 201 `{name,message}` | 400 invalid JSON/name/transport/command/url/args/env; 409 conflict |
| DELETE | `/api/tools/mcp/:name` | opt-in | 200 `{removed}` | 404 `{error:"MCP server not found"}` |
| GET | `/api/agency` | token | 200 detection | 500 |
| GET | `/api/agency/gallery/status` | token | 200 status `{...,local,canMutate}` | 500 |
| GET/POST | `/api/agency/gallery/setup` | POST opt-in | 200 diagnostics | 400 action; 500 |
| POST | `/api/agency/install-agency` | opt-in + Origin check | 200 `{ok,launched,platform}` | 403 cross-origin; 500 |
| GET | `/api/agency/gallery/search` | token | 200 `{count,results}` | 500 |
| GET | `/api/agency/gallery/plugin/:id` | token | 200 `{plugin,consent}` | 404; 500 |
| GET | `/api/agency/gallery/installed` / `install-state` | token | 200 `{installed}`/`{state}` | 500 |
| POST | `/api/agency/gallery/install` | opt-in | 200 result | 400 `{error:"id is required"}`; 500 |
| POST | `/api/agency/gallery/force-update` | opt-in | 200 result | 400 id; 500 |
| POST | `/api/agency/gallery/uninstall` | opt-in | 200 result | 400 `{error:"spec or id is required"}`; 500 |
| POST | `/api/agency/gallery/refresh` | opt-in | 200 result | 500 |
| POST | `/api/agency/gallery/publish` | opt-in | 200 result | 400 name/description; 500 |
| POST | `/api/agency/publish/prepare` / `scrub` / `submit` | opt-in | 200 result | 400 inputs; submit 400 if no catalog clone; 500 |
| POST | `/api/skills/refresh` | token | 200 `{skills}` | 500 |
| GET | `/api/skills` | token | 200 `{skills}` | 500 |
| GET | `/api/skills/:name` | token | 200 skill+content | 404; 500 |
| GET | `/api/update/status` | token | 200 `{currentVersion,lastCheck,autoUpdaterState}` | |
| GET | `/api/update/log` | token | 200 text/plain | 404 text/plain `"No update log available"` |
| GET | `/api/update/branches` | token | 200 `{branches:[]}` | |
| POST | `/api/update/check` | token | 200 `{available,checkedAt}` | |
| POST | `/api/update/apply` | token | 410 deprecation | |
| GET | `/api/data-dir` | token | 200 `{data_dir,runtime_dir,is_custom}` | |
| POST | `/api/validate-path` | token | 200 `{valid,error?}` | 400 `{valid:false,error:"path is required"}` |
| POST | `/api/browse-folder` | token | 200 `{path}` | 500 |
| POST | `/api/migrate-data` | token | 200 `{status:"migrated",...}` | 400 target_dir/validation; 500; **restarts daemon** |
| GET | `/api/audit` | token | 200 `{entries}` | |
| GET | `/api/health` | token | 200 `{status,pid,uptime,version,commitSha,deployTimestamp,deployTime,agent_name,agent_emoji,model,isLocal,branch?,tunnelUrl?}` | |
| GET | `/api/models` | token | 200 models[] | 503 `{error:"Session manager not available"}` |
| (any method) | `/api/extensions/<id>/...` | per-route `requiresLocal` | handler-defined | 403 local-only; 413/500 on throw; 404 no-match |

`redactConfig` masks any field whose whole name matches `api_key`, `token`, `*_token`, `password`, `secret`, `*_secret`, `flow_url` (recursively) with the literal string `[REDACTED]`. `token_mode` and other `token_*` non-secret fields are NOT masked.

### C. WebSocket message catalog

Client → Daemon (`type` is required on every message):

| type | fields | effect |
|---|---|---|
| `auth` | `token`, `clientKind?:"cli"\|"ui"` | authenticate; → `auth_ok`/`auth_fail` |
| `connect` | `sessionName` | join session; → `connected` (+`system_message` if setup needed / safe mode) |
| `send_message` | `channelId?`, `content`, `mention?`, `replyTo?:{role,content,timestamp?}`, `attachments?:[{name,mimeType,data(base64)}]`, `requestedAgents?:string[]`, `requestedSkills?:string[]` | send chat turn; requires `channelId` (→`error` otherwise); if session busy → `message_queued`; else processes (→`thinking`/`chunk`/`tool_call`/`complete`) |
| `slash_command` | `command` | only `/audio` / `/synthesize-audio` recognized; else `system_message "Unknown command: ..."` |
| `synthesize_audio` | `channelId?`, `sourceText`, `topic?` | audio synthesis turn |
| `switch_model` | `model` | → `system_message`/`error` |
| `get_history` | — | → `connected` (paginated 50) |
| `list_sessions` | — | → `sessions_list` |
| `list_agents` | — | → `agents_list` |
| `list_channels` | — | → `channel_list` |
| `create_channel` | `name`, `emoji?`, `description?` | → `channel_created` / `error` (general blocked) |
| `switch_channel` | `channelId` | → `channel_switched` / `error` (fast-path) |
| `refresh_channel_context` | — | → `system_message`/`error` |
| `archive_channel` | `channelId` | → `channel_archived` / `error` |
| `update_channel` | `channelId`, `updates` | → `channel_list` / `error` |
| `user_input_response` | `requestId`, `answer?`/`response?`, `wasFreeform?` | resolves an `ask_user`; → `error` if missing/no pending |
| `update_confirm_response` | `action:"confirm"\|"postpone"` | answers an update confirm |
| `cancel` | — | aborts main agent → `cancelled{scope:"main"}` |
| `cancel_agent` | `agentId` | → `cancelled{scope:"agent",agentId}` / `system_message` |
| `inject_context` | `content`, `channelId?`, `attachments?` | mid-turn injection; → `injecting` then normal turn / `error` |
| `load_more` | `before?`, (`limit?`) | → `history_chunk` |
| `sub_agent_checkpoint_response` | `agentId`, `action:"continue"\|"stop"` | resolves a checkpoint |
| `permission_response` | `requestId`, `decision:"allow"\|"deny"`, `alwaysAllow?`, `sessionTrust?` | resolves a `permission_request` |
| `presence` | `visibility?`, `focused?`, `recentActivity?`, `lastActivityAt?`, `channelId?` | updates presence (UI clients only; fast-path) |
| `client_diagnostic` | `kind`, `detail?`, `channelId?`, `at?`, `metadata?` | logged server-side |
| `pty_open` | `ptyId`, `args?`, `cols?`, `rows?`, `cwd?`, `persistent?`, `tmuxSessionId?` | open PTY; → `pty_data`/`pty_error` |
| `pty_input` | `ptyId`, `data(base64)` | write to PTY |
| `pty_resize` | `ptyId`, `cols`, `rows` | resize PTY |
| `pty_close` | `ptyId` | close PTY |
| `pty_list_persistent` | — | → `pty_persistent_list` |
| `pty_kill_persistent` | `sessionId` | → `pty_persistent_killed` |
| `ping` | — | → `pong` (fast-path) |

Daemon → Client:

| type | fields | trigger |
|---|---|---|
| `auth_ok` | `version?`, `commitSha?`, `deployTime?` | valid auth |
| `auth_fail` | `reason` | bad/absent auth (closes with 4001 if token invalid) |
| `connected` | `sessionName`, `model`, `history:ChatMessage[]`, `hasMore?`, `totalCount?`, `offset?`, `busy?`, `safeMode?` | `connect` / `get_history` |
| `channel_switched` | same as `connected` minus name = `channelId` | `switch_channel` |
| `chunk` | `text` | streaming assistant text |
| `tool_call` | `toolName`, `status`, `toolCallId?`, `args?`, `result?`, `duration?` | tool execution updates |
| `complete` | `artifacts?`, `timings?` | turn finished |
| `error` | `message` | turn/op error |
| `thinking` | `label` | turn started (also drives `channel_busy` broadcast) |
| `channel_busy` | `channelId` | broadcast to ALL clients when a channel starts processing (on `thinking`) |
| `channel_idle` | `channelId` | broadcast to ALL when a channel finishes (`complete`/`error`/top-level `cancelled`) |
| `verbose` | `label`, `detail` | reasoning/verbose events |
| `system_message` | `content`, `channel?`, `timestamp`, `kind?`, `taskId?` | system notices |
| `sub_agent_status` | `content`, `timestamp` | periodic sub-agent status |
| `sub_agent_spawned` | `agentId`, `role`, `runningForSec?` | sub-agent started |
| `sub_agent_chunk` | `agentId`, `role`, `text` | sub-agent streaming |
| `sub_agent_complete` | `agentId`, `role`, `success`, `summary?`, `durationMs?` | sub-agent done |
| `sub_agent_checkpoint` | `agentId`, `role`, `durationSec`, `question` | long-running sub-agent checkpoint |
| `heartbeat_tick` | `tick`, `timestamp`, `actions[]` | heartbeat engine |
| `cancelled` | `scope:"main"\|"agent"`, `agentId?` | cancellation |
| `sessions_list` | `sessions[]` | `list_sessions` |
| `agents_list` | `agents:ActiveAgent[]` | `list_agents` |
| `channel_list` | `channels[]` | `list_channels`/`update_channel` |
| `channel_created` | `channel` | `create_channel` |
| `channel_updated` | `channel` (partial + `id`) | channel update |
| `channel_archived` | `channelId` | `archive_channel` |
| `cross_channel_activity` | `channelId`, `channelName`, `summary` | work finished on a channel a client isn't viewing |
| `user_input_request` | `requestId`, `question`, `choices?`, `allowFreeform` | agent `ask_user` |
| `task_created`/`task_updated` | `task` | task store events |
| `task_progress` | `taskId`, `progress`, `status` | task progress |
| `task_completed` | `taskId`, `result`, `artifactIds?` | task completed |
| `task_failed` | `taskId`, `reason` | task failed |
| `task_queued` | `taskId`, `title`, `priority` | task queued |
| `task_execution_started` | `taskId`, `title`, `role` | task execution started |
| `update_available` / `update_confirm` | `currentVersion`, `newVersion`, `message` | updater |
| `update_starting` | `newVersion`, `countdownSeconds` | updater |
| `update_countdown` | `secondsLeft` | updater |
| `update_applying` / `update_complete` | (`newVersion` on complete) | updater |
| `injecting` | — | `inject_context` started |
| `message_queued` | `position` | message queued behind a busy session |
| `queue_update` | `remaining` | queue drained one |
| `permission_request` | `requestId`, `toolName`, `category`, `description`, `riskScore`, `timeoutSec`, `timeoutDecision:"allow"\|"deny"`, `args?` | permission approval needed |
| `permission_decision` | `requestId`, `decision`, `ruleId`, `reason` | auto/rule decision |
| `trust_suggestion` | `patternId`, `signature`, `approvalCount`, `description` | trust pattern suggestion |
| `emergency_stop` | — | emergency stop |
| `daemon_restart` | — | restart imminent |
| `user_message` | `content`, `timestamp` | echoed user message |
| `pty_data` | `ptyId`, `data(base64)` | PTY output |
| `pty_exit` | `ptyId`, `code`, `signal` | PTY exited |
| `pty_error` | `ptyId`, `message` | PTY error |
| `pty_persistent_list` | `available`, `sessions:[{id,label,cwd,createdAt,lastAttachedAt}]`, `error?` | `pty_list_persistent` |
| `pty_persistent_killed` | `sessionId`, `ok`, `error?` | `pty_kill_persistent` |
| `pong` | — | `ping` |
| `history_chunk` | `messages`, `hasMore`, `offset` | `load_more`/`get_history` (sent on the wire though not in the typed union) |

`ChatMessage` (history element) shape: `{ id, role:"user"|"assistant"|"system"|"tool"|"sub-agent", content, kind?:"heartbeat"|"retry"|"info"|"reminder", taskId?, reminderDismissed?, agentRole?, agentEmoji?, timestamp, channelId?, mentionedAgent?, replyTo?, attachments?:[{name,mimeType,data?}], metadata?:{requestedAgents?,requestedSkills?}, artifacts?, timings?:{requestStartedAt,firstChunkAt?,completedAt?,elapsedMs?,timeToFirstTokenMs?}, toolCalls?:[{toolCallId,toolName,args?,result?,duration?,status,timestamp?}], verboseEvents?:[{label,detail?,timestamp}], usage?:{model,inputTokens,outputTokens,cost?,durationMs?} }`.

Every `broadcastToSession` message is wire-tagged with an extra `_channel: <sessionName>` field for client-side cross-channel routing validation.

### D. Broadcast routing rules

- `send`: to one client only if its socket is OPEN.
- `broadcastToSession(sessionName, msg)`: to all authenticated clients whose `sessionName === sessionName` (tagged with `_channel`). Additionally: on `thinking` → broadcast `channel_busy{channelId}` to ALL clients; on `complete`/`error`/top-level `cancelled` → broadcast `channel_idle{channelId}` to ALL, plus completion notifications + cross-channel activity to other channels.
- `broadcastAll(msg)`: to every authenticated client (used for task events, heartbeat, emergency_stop, daemon_restart, channel_busy/idle).

---

## Coverage notes

- **Verified at HEAD against source:** `src/daemon/server.ts`, `api-router.ts`, `protocol.ts`, `auth.ts`, `route-helpers.ts` (rate limit / body cap / `isLocalRequest`), `plugins/{types,plugin-host,loader}.ts`, `tunnel-manager.ts`, and `bin/claw-daemon.ts`. The full REST endpoint table (router routes, lines 1244–4014) was extracted by a dedicated read of `api-router.ts` and cross-checked against the README's REST API table; the README matches the source for the documented subset, and the table here is the superset actually present in source.
- **Response body field-level detail for some router endpoints is described by shape, not always key-by-key**, because the bodies are produced by downstream stores/services (e.g. `store.list()`, `queryArtifacts()`, `getSummary()`, channel/task/pin objects, `redactConfig` output). A re-implementer matching the wire contract must treat those object shapes as defined by their respective stores; the keys named in the table are the directly-constructed response wrappers (e.g. `{deleted:<id>}`, `{channelId,messages}`), which are exact.
- **`SessionManager` internals were read only as needed** (the `thinking` emission point that triggers `channel_busy`, the `sendMessage`/triage/dedup flow, init). The full message-processing/persistence/safe-mode logic of the session/orchestrator layer is out of this subsystem's scope (it is the AI-session subsystem, not the API/transport surface) and is not specified here beyond how it surfaces over the WS protocol.
- **`history_chunk` server→client message** is emitted on the wire (cast `as any` in server.ts) but is NOT in the typed `DaemonMessage` union in `protocol.ts`. Documented here from the runtime emit sites; a re-implementer must include it.
- **CLI vs REST tunnel auth-provider divergence:** the CLI `tunnel enable` defaults to `github`, while the REST `/api/tunnel/enable` and `/api/tunnel/login` force Microsoft/Entra. Both verified in source; intentional.
- **Not exhaustively specified:** the exact JSON of `comm-channels`/`completion-notifications`/`agency` detection/gallery objects, `getStatus()`/`getDiagnostics()` of comm channels, squad dashboard internals, and PTY manager behavior beyond the message catalog — these are downstream module outputs surfaced verbatim and would require reading those modules to pin every field. They are flagged here rather than guessed.
- **Auto-start install/uninstall OS specifics** (the actual scheduled-task/LaunchAgent/systemd mechanics) live in `src/daemon/lifecycle.ts` (not read in full); only the observable CLI output and effect are specified.
