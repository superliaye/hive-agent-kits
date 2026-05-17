# Audit Log Design

## What this ADR records

How **Audit** works in Hive v1: its purpose, how events get into it, what events get in, where they're stored, how secrets stay out, what happens when it fails, and how it ages out. Sharpens the **Audit Log** term in CONTEXT.md and constrains every module's event-emission surface.

Primary purpose: **the record of what users and agents did** — answering "what happened, who triggered it, and when?" Tamper-evidence is a v1.1 concern (hooks reserved in the schema, no migration needed to add later). Replay-as-executable-history is an explicit non-goal for v1.

System-internal diagnostics (parse errors, watcher failures, startup chatter, performance counters) live in a separate **Trace Log**, not the Audit Log. See "Audit vs trace" below.

## Audit vs trace

**Audit answers "what did the user or agent do?"** It is the record of decisions and side effects with a user-visible consequence: a binding toggled in the UI, a Tool call inside a Run, a Memory write, a Permission decision, a Secret access, a Harness rewrite by the Agent Manager. Persisted in SQLite. Retained forever by default. Queryable via the daemon's `GET /api/audit` route (the future `hive audit query` CLI will be a thin wrapper around it) or directly via `sqlite3 -readonly ~/.hive/audit.db`.

**Trace answers "why didn't this work?"** It is the diagnostic stream the system writes about its own operation: malformed-manifest skip, filesystem watcher error, daemon startup phase, hot-reload rescan, gateway latency, CLI subprocess capture. Persisted as JSONL via Pino at `<runtime>/logs/daemon.log`. Rotation by tooling, retention modest, freely deletable.

Same subscribe-pattern primitive (typed event streams from each module), two consumers:

| Event | Goes to audit? | Goes to trace? |
|---|---|---|
| `harness.updated` (UI binding toggle) | **yes** | yes (any handler can log) |
| `harness.updated` (Agent Manager Run rewrite) | **yes** | yes |
| `agent.created` (Agent Manager creates a new Worker) | **yes** | yes |
| `agent.created` at startup scan (inventory) | no | yes |
| `capability.registered` at startup scan (inventory) | no | yes |
| `capability.changed` from hot-reload (system) | no | yes |
| `config.change` (user edited or set via Settings UI) | **yes** | yes |
| `tool_use.executed` (agent invoked a Tool in a Run) | **yes** | yes |
| `gateway.adapter.registered` at startup | no | yes |
| malformed manifest, parse error | no | yes |
| daemon startup chatter | no | yes |
| MCP server crash/restart | **yes** (lifecycle visible to user) | yes (diagnostic detail) |

The line: **was a user or agent the proximate cause?** If yes, the event is an audit fact ("this happened on the user's behalf"). If no — the system observed something during normal operation — it's trace.

**Mechanics:**

- Modules emit one typed event stream (`events: TypedEmitter<...>`). That stream is the shared input.
- The Audit subscriber (`wireSubscriptions`) attaches a *partial* normalizer per source — only the event types that represent user/agent actions are written to `audit.db`.
- The Trace channel is **not** an event subscriber. Modules import a Pino singleton (`src/lib/log.ts`) and write structured records directly: `log().warn({ module, path, err }, "skipped malformed manifest")`. Pino is a thin call, not a subscribe-pattern receiver; trace is "everything the module wanted to say about its own state."
- Why no Trace subscriber? Diagnostic context is best emitted at the call site (full local state, full stack), not after normalization through an event schema. The subscribe pattern is right when the consumer wants a uniform shape; trace consumers want raw context.

This split is what keeps `audit.db` quiet at boot (no startup-inventory storm) and lets `daemon.log` capture diagnostic detail that would be noise in audit. The two stores answer different questions; conflating them produced "is this row useful or noise?" on every query.

## What changed when this section landed (amendment)

The original ADR-0004 framed audit's purpose as "debuggability and inspection." That framing was too wide: it pulled diagnostic spew into the audit table. The sharpened framing is "what users and agents did"; diagnostic concerns moved to the Trace Log. The subscribe-pattern primitive and the SQLite schema are unchanged; what changed is which events the audit subscriber attaches a normalizer for.

## Subscribe, don't push

The defining structural commitment: **modules do not call into Audit.** No module imports an `Audit` module. There is no `audit.record(...)` API exposed to emitters.

Instead, each module owns a typed event stream emitted as a side effect of its operations. The **Audit Log is a subscriber** — it consumes these streams, normalizes each event into a common `AuditEvent` row shape, and persists. Nothing reaches *into* Audit; Audit reaches *out*.

```
   ┌────────────────┐
   │     Run        │──events──►┐
   └────────────────┘            │
   ┌────────────────┐            │
   │  Permission    │──events──►┤
   └────────────────┘            │
   ┌────────────────┐            │       ┌──────────────────┐
   │   Secrets      │──events──►┼─────► │  Audit (sub)     │ ─► audit.db
   └────────────────┘            │       └──────────────────┘
   ┌────────────────┐            │           (also ─► UI, future exporters)
   │  MCP / Memory  │──events──►┤
   │  Registry      │            │
   │  Lifecycle     │            │
   │  Backend       │──events──►┘
   └────────────────┘
```

This is the same shape that lets the UI consume `RunEvent`s for streaming, lets a future observability exporter (OpenTelemetry, Prometheus) plug in, and lets training-data dumpers attach — without touching emitters. Every cross-cutting reader is one of N subscribers; emitters know about none of them.

## What gets audited

Eight emitter modules, all on day one:

| Source | Example event types | Granularity |
|---|---|---|
| **run** | `run.started`, `run.message.assistant`, `run.tool_use.requested`, `run.tool_use.executed`, `run.completed`, `run.cancelled`, `run.errored` | operation-level — full assistant message after streaming, each tool call, each completion. No token deltas. |
| **permission** | `permission.requested`, `permission.decided`, `permission.user_responded` | every decision |
| **secrets** | `secrets.resolved`, `secrets.refreshed`, `secrets.failed` | every access; **never the value** |
| **mcp** | `mcp.server.started`, `mcp.server.stopped`, `mcp.server.crashed`, `mcp.server.restarted`, `mcp.tool.invoked` | every server lifecycle, every tool invocation |
| **memory** | `memory.write`, `memory.search` (reads optional; default off) | every write |
| **registry** | `capability.registered`, `capability.unregistered`, `capability.bound` | every change |
| **lifecycle** | `agent.created`, `agent.updated`, `agent.destroyed`, `harness.written` (with snippets consulted) | every Agent Manager action |
| **backend** | `backend.spawned`, `backend.exited` | every CLI subprocess (claude-code, codex) |

Operation-level granularity (vs. full stream-level) is the deliberate trade-off: token deltas are a presentation concern that lives in the UI's WebSocket relay; the audit log captures **decisions and side effects**, not the bytes of how text was streamed.

Rejected:
- **Stream-level** — every `RunEvent` including token deltas. ~10K rows per Run, signal drowns in noise, query slows. Storage isn't the issue; *usefulness* is.
- **Turn-level only** — no per-tool detail. Misses exactly what debug needs.

## Storage: single SQLite table, its own file

Audit lives in a separate SQLite file: `~/.hive/audit.db`. Not in the main Hive DB.

Reasons:
- `cp ~/.hive/audit.db /elsewhere/` for offline analysis without locking the main DB.
- Delete it entirely without breaking Hive (just resets the log).
- Rotation operations don't affect Agent Catalog / Threads / Runs performance.
- v1.1 dual-sink (SQLite + optional JSONL append for tamper-evidence) can be added without disrupting the main DB.

Schema (single `audit_events` table; concrete Drizzle shape):

```ts
audit_events = sqliteTable({
  id:               text("id").primaryKey(),         // UUID
  ts:               integer("ts").notNull(),         // ms since epoch
  run_id:           text("run_id"),                  // FK Runs (nullable for lifecycle events outside a Run)
  agent_id:         text("agent_id"),                // FK Agents
  source:           text("source").notNull(),        // 'run' | 'permission' | 'secrets' | 'mcp' | 'memory' | 'registry' | 'lifecycle' | 'backend'
  event_type:       text("event_type").notNull(),    // module-defined; e.g. 'tool_use.executed'
  payload:          text("payload", { mode: "json" }).notNull(),  // module-specific shape, validated by module's Zod schema before write
  parent_event_id:  text("parent_event_id"),         // populated when natural; null otherwise
  prev_hash:        text("prev_hash"),               // reserved v1.1 tamper-evidence
  signature:        text("signature"),               // reserved v1.1
})
```

Indices on `(run_id, ts)`, `(agent_id, ts)`, `(source, ts)`.

The JSON payload absorbs schema evolution without table migrations — when a module adds a field to its event shape, old rows simply lack it; queries tolerate both shapes.

`prev_hash` and `signature` are reserved for v1.1 tamper-evidence (hash-chained rows, periodic signing). Null in v1; non-null when v1.1 ships. Zero migration cost.

Rejected:
- **Multiple typed tables per source** — `SELECT * WHERE run_id = ?` would become a UNION across 8 tables; query complexity outweighs typing wins.
- **JSONL file as primary** — we don't have tamper-evidence as v1 primary purpose; building our own query layer over JSONL reinvents SQLite.
- **Hybrid SQLite-index + JSONL** — two sources of truth, two writes per event, drift risk. v1.1 might add JSONL as a *secondary* sink alongside SQLite for tamper-evidence; not now.

## Redaction: emitter primary, pattern-match backstop

Secrets must never appear in the audit payload. Two layers:

**Primary — emitter-side.** Each module is responsible for not including sensitive values in events it emits. Concretely:
- Secrets module emits `{ref, source, agent_id, success}` — never the resolved value. The emission code path doesn't have the value object.
- MCP module emits `{server, command, env_keys}` — keys yes, values no.
- Run module redacts tool arguments before emitting based on the Tool manifest's `sensitiveFields` declaration. For `run_shell` specifically, every string arg is treated as suspect.

**Backstop — pattern-match in the subscriber.** Even with disciplined emitters, two cases leak: (a) user pastes "my key is sk-…" into a chat message; (b) the model generates text containing what looks like a token. Before any string field in a payload is persisted, the Audit subscriber scans for known secret shapes:

```
sk-[A-Za-z0-9]{20,}            OpenAI-style
sk-ant-[A-Za-z0-9_-]{20,}      Anthropic API
gh[ps]_[A-Za-z0-9]{20,}        GitHub tokens
glpat-[A-Za-z0-9_-]{20,}       GitLab PAT
xoxb-[A-Za-z0-9-]{20,}         Slack bot
AKIA[0-9A-Z]{16}               AWS access key
AIza[0-9A-Za-z_-]{35}          Google API
# extensible list
```

Matches are replaced with `[REDACTED:<shape>]` (the shape name lets debugging know what *kind* of value was masked without revealing it).

This is belt-and-suspenders. Primary defense is the emitter; backstop catches what the emitter couldn't have known about.

Rejected:
- **Subscriber-side as primary** — requires the subscriber to guess at field semantics in opaque JSON; field-name heuristics (`field.includes("token")`) fail at `authValue`, `bearer`, `credential`.
- **Read-time only** — stores secrets on disk; catastrophic on export, support handoff, or sync.

## Failure semantics: block, with transaction split

**Audit failure blocks the originating operation.** If the audit subscriber cannot persist an event, the operation that emitted it fails. No silent gaps.

Rationale: the primary purpose (debuggability) is destroyed by silent loss. A 30% drop rate from drop-on-failure looks like nothing's wrong until you try to debug something and the record isn't there. SQLite + WAL writes almost never fail under normal conditions; when they do (disk full, file locked, schema mismatch in payload), surfacing the problem loudly is the right behavior. If block-on-failure becomes a latency problem later, the migration to buffered async writes is local to the Audit module — emitters don't change.

**Audit and main DB are separate SQLite files**, so a true cross-file transaction is not available. Hive intentionally chooses **best-effort separate-transaction semantics** with **audit-first ordering**:

1. The emitting module emits its event. The Audit subscriber writes the audit row inside its own transaction (in `audit.db`). If that write fails, the emit fails (block-on-failure), and the operation that triggered the emit fails *before* it commits any side effect.
2. Only after the audit write succeeds does the emitter proceed with its actual side effect (e.g., the Memory module commits to `hive.db`).
3. If the side effect then fails after the audit row was written, the audit log contains an "attempt" record that no main-DB row corresponds to. **This is acceptable** — the agent (or developer) reading the audit log can reason about what was attempted and what landed, and reconcile by comparing audit rows against main-DB state. Audit is observational; it is not the system of record for main-DB state.

This trades the originally-aspirational same-transaction guarantee for an architecture that actually works under "separate files" and still surfaces all failure modes. Crashes between an audit row and a side-effect commit produce visible discrepancies, not silent gaps. Every attempted operation is traceable; the audit log over-records rather than under-records.

## Retention: configurable, default forever

Default: keep everything. Forever. SQLite handles ~18M rows/year at typical use without trouble; rotation is a hypothetical performance issue, not a real one at v1 scale.

Optional time-based auto-rotation is supported:

```yaml
audit:
  retention:
    autoRotate: false       # default
    days: 90                # used only when autoRotate: true
    archiveTo: "rotate"     # "rotate" (move to JSONL) | "delete"
```

When `autoRotate: true`, a daily background job in the daemon scans the audit table; rows older than `days` are moved to `~/.hive/audit-archive/YYYY-MM.jsonl` (lossless rotation) or deleted (if `archiveTo: "delete"`).

Rejected:
- **Auto-rotation by default** — silent loss; defeats debug-primary purpose for users who never touch the setting.
- **Per-source retention policies** — too much config; new decision per source, new place for bugs. Single global window is enough.
- **Size-based rotation** — works fine in principle but requires choosing a threshold; time is more intuitive.

Query surfaces (v1 ships the HTTP route + `sqlite3` access; the `hive` CLI is deferred to v1.1):

```bash
# HTTP (any client, auth-gated, JSON):
curl -H "Authorization: Bearer $(cat ~/.hive/.token)" \
  'http://127.0.0.1:3117/api/audit?source=permission&since=<microseconds>&limit=100'

# Ad-hoc local SQL (read-only, safe alongside the daemon's WAL writer):
sqlite3 -readonly ~/.hive/audit.db \
  "SELECT datetime(ts/1000000,'unixepoch') t, source, event_type, agent_id
   FROM audit_events WHERE run_id = '<id>' ORDER BY ts;"
```

Future `hive` CLI surface (deferred — none of these exist yet; they will wrap the HTTP route + add ad-hoc helpers):

```
hive audit query --run <id>            # show events for a Run
hive audit query --agent <id> --since 7d
hive audit query --source permission --deny
hive audit export --before 2025-01-01 --to archive.jsonl
hive audit prune  --before 2025-01-01
hive audit stats                       # row counts by source, oldest event, db size
```

## Causal hierarchy

`parent_event_id` is populated when natural — a `tool_use.executed` event's parent is its `tool_use.requested`; a `permission.decided` event's parent is the `tool_use.requested` it gated; a `memory.write` event's parent is the `tool_use.executed` that triggered it. Null when no clear parent.

No schema enforcement; no synthetic roots. Today's UI can render flat-by-timestamp ignoring the field; tomorrow's UI can render trees. Additive growth.

## Implications for module interfaces

The subscribe pattern only works if every module exposes a typed event stream. Concretely:

- **Run module** — already exposes `startRun(thread, agent) → AsyncIterable<RunEvent>` (pinned in ADR-0003). The same stream feeds the UI's WebSocket relay and the Audit subscriber.
- **Permission module** — must expose a `decisions: AsyncIterable<PermissionDecision>` (or equivalent typed event stream).
- **Secrets module** — must expose a `accesses: AsyncIterable<SecretAccess>` stream.
- **MCP module** — must expose `serverEvents` and `toolInvocations` streams.
- **Memory module** — must expose `writes: AsyncIterable<MemoryWrite>` and optionally `reads`.
- **Capability Registry** — must expose `changes: AsyncIterable<RegistryChange>`.
- **Agent Manager (lifecycle)** — must expose `lifecycleEvents`.
- **Backend (CLI spawn)** — must expose `processEvents`.

Each module owns its event types and their Zod schemas. The Audit subscriber validates incoming events against these schemas before normalizing to the common `AuditEvent` row and persisting.

## Build sequencing & discipline

Audit is **not a feature delivered in a single slice.** It's a thin subscriber (~200 LOC) that grows by attaching to new module event streams as those modules ship. Real cost of "great audit" lives in the emitter modules, not in audit itself.

Concretely:

- Audit lands **before any other module exists**, as a self-contained deep module fully tested in isolation against synthetic event streams. Prerequisites: `TypedEmitter<T>` primitive in `src/lib/`, SQLite + Drizzle scaffolding, `~/.hive/` paths helper, `bun test`. No Run, no Permission, no Memory needed to validate audit end-to-end.
- The audit module's public seam is two verbs: `attach(events, normalizer)` to wire a typed event stream + per-event-type normalizers, and `query(filter)` to read persisted events. Behind the seam: redaction backstop, normalization dispatch, ID/timestamp generation, parent tracking, SQLite write (with block-on-failure transaction semantics), tamper-evidence column hooks (null in v1).
- Tests inject synthetic `TypedEmitter`s and assert on `query()` results plus row contents. Each behavior (persistence, redaction, transaction semantics, query filters, schema additivity) is exercised in isolation. No mocks of other modules — they don't exist yet and aren't needed.
- Each subsequent module slice adds its event stream and one line in `src/audit/subscriptions.ts` (`audit.attach(<moduleEvents>, <moduleNormalizer>)`). At every stage, audit's interface is stable; only the wire-up file changes.

Why land audit first? Because the inputs to audit are simulated, building it standalone forces its interface to be honest — if "great audit" requires Run to be partly built first, the seam is wrong. Building it against synthetic inputs proves the interface stands on its own.

The discipline of "every module emits, audit subscribes" is a **convention, not a mechanically enforced contract.** Hive is a single-author personal system; rigid forcing functions slow exploration without catching enough real misses to justify them. We rely on a light set:

1. **AGENTS.md awareness.** The model-agnostic instructions file (mirrored to `CLAUDE.md`) primes every coding session with audit awareness — what audit is, that it uses a subscribe pattern, that secrets stay out of payloads. Future contributors (human or AI) read it before writing code. Highest-leverage layer because it shapes how code is written in the first place.
2. **Code review.** When a new module or a new public verb lands, the reviewer checks for emission. For a single-author repo, the author *is* the reviewer; the discipline is "ask myself before merging."
3. **Daemon-startup observability.** The Audit subscriber logs which modules it's attached to at boot — `[audit] subscribed to N module event streams: run, permission, secrets, mcp, …`. Gaps are visible in the log without being errors.
4. **Optional test helpers.** For modules where audit coverage is critical (permission decisions, secrets access), tests can assert emission directly. Not required across all modules.

We considered and rejected stricter mechanical enforcement — a `defineModule()` helper that fails to compile without an event stream, a CI lint rule. The friction wasn't worth it for a personal system where exploration speed dominates.

## What this defers (v1.1+)

- **Tamper-evidence.** Hash-chained rows (`prev_hash`), periodic signing (`signature`). Fields are already reserved in the schema; v1.1 fills them in with a chain-validation tool. No data migration.
- **Replay as executable history.** Capturing model nondeterminism (seed, exact provider response, exact tool result bytes) for deterministic replay. Useful for training data export and regression tests; not a v1 commitment. Audit hooks support it; the kernel doesn't guarantee determinism.
- **Cross-deployment audit sync.** When Personal-origin Capabilities sync between deployments (ADR-0001 blocker #1), do audit rows from Deployment A travel? Probably not — audit is per-deployment by default. Worth revisiting in the sync ADR.
- **Multi-user audit.** Per-user identity in the audit row. v1 is single-user; no field today. Add when multi-user lands.

## Verification

This ADR is correct if, after implementation, the following hold:

1. **Every successful state-changing operation produces an audit row** in the same DB transaction. Crashing between the operation and the audit write is impossible.
2. **No module imports `Audit`**. Audit subscribes to every other module's event stream; the dependency graph runs one direction only.
3. **A test that intentionally emits an event containing `sk-test123abc456…` ends up with `[REDACTED:openai-key]` in the persisted row**, not the raw value.
4. **Disabling the audit subscriber (test scenario) causes every operation in the system to fail** with a clear error — there is no silent-degrade path.
5. **`GET /api/audit?run_id=<id>` reconstructs the full timeline** of a Run including permission decisions, tool calls, results, errors, and memory writes — without joining any other table. (The future `hive audit query --run <id>` CLI will be a thin wrapper around the same route.)
6. **Deleting `~/.hive/audit.db` does not corrupt Hive state** — the next operation creates a fresh empty audit file and continues.

If any of these is false, the design is wrong — fix here before further commitments.
