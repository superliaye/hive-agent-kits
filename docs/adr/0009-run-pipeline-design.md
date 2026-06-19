# Run Pipeline Design

status: Superseded by ADR-0021 — the Run/Thread pipeline is deleted with the
agent-running stack (parked as deferred #2).

## What this ADR records

How `Threads` + `Runs` work in Hive v1: the persisted Thread → Message history layer, the Run executor that drives `ModelGateway.complete()` with `Secrets`-resolved auth, and the event-stream contract between the executor and its consumers (Part 4 HTTP route, Part 5 UI). Establishes the boundary between Threads (data), Runs (process), and the future tool-execution loop (Part 7).

## Scope

In scope:

- Drizzle schema for `threads`, `messages`, `runs` tables in shared `~/.hive/hive.db`.
- `Threads` module: CRUD for threads + messages, transactional `idx` assignment.
- `Runs` module:
  - `RunsStore` — lifecycle CRUD against the `runs` table.
  - `RunExecutor` — the streaming Run loop.
- Audit subscription for Run lifecycle events (`run.started` / `run.completed` / `run.failed` / `run.cancelled`).
- Boot-time stale-Run recovery (`markStaleAsFailed`).

Out of scope (defers):

- Tool execution. Run stops at `done(tool_use)`; future Part 7 handles dispatch + re-running with tool_results.
- HTTP routes (Part 4) and chat UI (Part 5).
- Per-token persistence — only lifecycle is durable.
- Per-Run model override surfaces in Part 4 (the route plumbs `modelOverride` through to `startRun`).
- Mid-stream OAuth refresh past the new access token's lifetime (handled in Secrets / pi-ai layer).

## Storage shape — shared `hive.db`

`~/.hive/hive.db` is the single SQLite file for hot conversation state (threads, messages, runs, future modules). `audit.db` is separate per ADR-0004 — different access pattern, different rotation/archive story, separate connection.

Three tables in this ADR:

```sql
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  role       TEXT NOT NULL,                -- 'user' | 'assistant'
  content    TEXT NOT NULL,                -- JSON: ContentBlock[]
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_thread_idx ON messages (thread_id, idx);

CREATE TABLE runs (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  model          TEXT NOT NULL,
  status         TEXT NOT NULL,            -- 'running' | 'completed' | 'failed' | 'cancelled'
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  finish_reason  TEXT,
  error_code     TEXT,
  error_message  TEXT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);
CREATE INDEX idx_runs_thread_started ON runs (thread_id, started_at);
CREATE INDEX idx_runs_status ON runs (status);
```

Bootstrap DDL is duplicated next to each Drizzle table definition in `ensure*Schema()` functions (matching the audit module pattern). `openHiveDb(path)` calls both. drizzle-kit migrations replace this when the schema first changes incompatibly.

### Normalized messages, not denormalized JSON

`messages` is its own table with FK + per-message `idx`, not a JSON column on `threads`. Per-message addressing — edit message N, retry from message N, future FTS5 search — is painful to retrofit against a denormalized blob. The extra table is cheap; the future flexibility is not.

### `content` as a JSON column

Each message's `content` is a JSON-serialized `ContentBlock[]` per `model-gateway/types.ts`. Schema-flexible at the column boundary so Anthropic-flavored shape evolution (new block types in future Anthropic API versions) doesn't require a DDL change. Application layer (`ThreadsStore.append`) takes typed input; reads return the canonical `ThreadMessage` shape.

### Why not store Run events too

Hybrid persistence: Run lifecycle yes (the `runs` row), per-token deltas no. Reasons:

- A chat UI either gets the live stream or refreshes and reads the final assistant message from `messages`. Replaying a per-token stream from disk isn't a real use case in v1.
- Per-token volume is high (hundreds of rows per Run). Persistence overhead — and the read-amplification when the UI catches up — costs more than the use case justifies.
- ADR-0004's audit log records lifecycle events at the same granularity, in a different DB. Per-token deltas would duplicate that record.

If reconnect-and-replay becomes a real feature later, add `run_events` keyed by `(run_id, seq)` and stream from there. Additive.

## Module split — Threads vs Runs

`src/threads/` (data) and `src/runs/` (process) are separate modules per ADR-0002's directory layout. Threads outlive Runs; the split maps cleanly to two responsibilities:

- `Threads` exposes CRUD and is single-tenant (one process; SQLite handles concurrency via transactions).
- `Runs` exposes `startRun(...)` as an `AsyncIterable<RunEvent>` and owns concurrency rules + the streaming model invocation.

Future modules (Memory, Permissions, MCP) attach as additional dependencies of `RunExecutor` without needing to know about Threads' internals.

## `RunEvent` — nested envelope

```ts
type RunEvent =
  | { type: "run.started";   runId, threadId, agentId, model, ts }
  | { type: "model.event";   runId, event: GatewayEvent }    // wraps every GW event
  | { type: "run.completed"; runId, finishReason, finalMessage, ts }
  | { type: "run.failed";    runId, error: { code, message }, ts }
  | { type: "run.cancelled"; runId, ts }
```

The nested `model.event` envelope keeps the discriminator clean: Part 4's SSE encoder maps each top-level `type` to a distinct SSE event name (`run.started`, `model.event`, …). The UI's consumer dispatches on `type` once. A flat union mixing GatewayEvent types with Run lifecycle types would force every consumer to know both shapes and disambiguate by overlapping `type` fields.

The `runId` is duplicated on every event so a single consumer can route streams from multiple concurrent Runs. `ts` lands on lifecycle events but not `model.event` — the wrapped GatewayEvent carries no timestamp of its own; the route layer adds a wall-clock receive time if the UI needs it.

## Agent → Model resolution

Three-layer per ADR-0003 §"Harness config is backend-specific":

1. **Per-Run override** — `startRun({modelOverride})`. Plumbed through Part 4's route.
2. **Harness `config.model`** — read from `Catalog.get(agentId).config.model` (string-typed at this key by convention; the harness schema is `z.record(z.string(), z.unknown())`).
3. **Deployment default** — `MODEL_FALLBACK = "anthropic/claude-haiku-4-5"` in `src/runs/defaults.ts`. Picked for cost + Anthropic-first per CLAUDE.md guidance.

If a level is missing, fall through. Malformed model (no `/`) is a Run failure (`run.failed{code:"invalid_request"}`) — the row exists for traceability.

## Concurrency — one Run per Thread

`startRun` on a thread with an in-flight Run **throws synchronously** (caller bug, not a Run failure). No Run row is created for the rejected request; nothing to audit. The Thread is "busy" from `startRun()` entry until the iterable terminates (`run.completed` / `run.failed` / `run.cancelled` yielded).

Multiple threads can run concurrently — busy-state is keyed by thread id.

Rejected:

- **Queue the second Run** — interleaved Runs on a Thread are undefined behavior (do they share the message history? lock-step? race?). Queueing hides the contradiction.
- **Yield `run.failed{code:"concurrent_run"}`** — generating a Run row + audit event for a caller bug pollutes the runs table.

## Cancellation

`cancelRun(runId)` aborts the underlying `AbortController` registered when the Run started. The signal reaches every cancellable edge of the Run, not just the gateway stream:

- **Gateway stream.** The signal flows into `CompletionInput.signal`; ModelGateway adapters (pi-ai, claude-cli) react with `done(cancelled)` per ADR-0005's verification list. The executor sees `done(cancelled)`, yields `run.cancelled`, and marks the Run row.
- **Tool dispatch.** The same signal threads through `dispatchToolCall` into the `ToolContext`. An already-aborted signal short-circuits dispatch (no gate, no run); `run_shell` forwards it to the `ShellRunner`, which kills the spawned child on abort and surfaces a non-zero exit (130) with a "process killed (run cancelled)" stderr note.

If `cancelRun` is called on an unknown id (already finished, never existed): no-op. Cancellation is fire-and-forget.

## Boot-time stale-Run recovery

On every server boot, `runsStore.markStaleAsFailed()` runs once. Any row still `status = 'running'` from a previous process is flipped to `failed` with `error_code = "daemon_restart"`. The streaming consumer of that Run is long gone; we can't resume the iteration. Resume would require persisting model context state, which is out of scope.

Trade-off: a Run that was 90% done is recorded as failed, not completed. The chat UI surfaces this and the user re-asks. Cheaper than the persistence machinery resume would require.

## Audit subscription

The `RunExecutor.events` emitter exposes only lifecycle events (`run.started`, `run.completed`, `run.failed`, `run.cancelled`). Per-token model events do **not** flow through this emitter — they're causally owned by the streaming consumer (`startRun()`'s `AsyncIterable<RunEvent>`), per ADR-0004's audit-vs-trace boundary. Trace logger picks up adapter-level diagnostics; audit captures the user/agent-driven lifecycle.

`wireSubscriptions` attaches `runs` to audit using source label `"run"` (singular, matches the existing `ModuleSource` enum). Payloads carry `runId`, `agentId`, `threadId`, `model`, `finishReason`, and classified error codes — never message content, never auth.

## Public API

```ts
// Threads
type Threads = {
  create({ agentId, id? }): Thread;
  get(threadId): Thread | undefined;
  getWithMessages(threadId): (Thread & { messages: ThreadMessage[] }) | undefined;
  listMessages(threadId): ThreadMessage[];
  append({ threadId, role, content }): ThreadMessage;
  getCompletionMessages(threadId): Message[];
  list(): Thread[];                                   // sorted by updatedAt desc
  remove(threadId): void;                             // cascades messages via FK
};

// Runs
type RunExecutor = {
  startRun({ threadId, userMessage, modelOverride? }): AsyncIterable<RunEvent>;
  getRun(runId): Run | undefined;
  cancelRun(runId): void;
  listByThread(threadId): Run[];
  events: TypedEmitter<RunModuleEvents>;
};

type RunsStore = {
  create(...): Run;
  complete({ runId, finishReason }): void;
  fail({ runId, code, message }): void;
  cancel(runId): void;
  get(runId): Run | undefined;
  listByThread(threadId): Run[];
  listByStatus(status): Run[];
  markStaleAsFailed(): number;
};
```

## Verification

This module is correct if, after implementation:

1. A text-only Run against the `fake` adapter emits `run.started → model.event(text_start) → model.event(text_delta)... → model.event(done) → run.completed` in order. Final message is persisted in `messages`.
2. A `tool_use` Run stops at `done(tool_use)` with the assistant message containing the `tool_use` block. No tool dispatch occurs.
3. A Run against a missing Agent emits `run.failed{code:"agent_not_found"}` and creates a `failed` row in `runs`.
4. A Run with no stored credentials for the provider emits `run.failed{code:"no_credentials"}`.
5. `cancelRun(runId)` mid-stream causes the iterable to end with `run.cancelled`, and the Run row's status flips to `cancelled`.
6. Two concurrent `startRun` calls on the same Thread: the second throws synchronously.
7. After daemon restart with a Run row left `running`, `markStaleAsFailed()` flips it to `failed{code:"daemon_restart"}`; subsequent fresh Runs proceed normally.
8. Per-message `idx` is monotonic and gap-free within a Thread, even under sequential `append` calls.

## What this defers

- **Tool execution loop.** Stops at `done(tool_use)`. Part 7 adds Capability dispatch, permission checks, MCP routing, and re-running with `tool_result` content blocks.
- **Per-Run model override surface.** Plumbed in code; HTTP route exposes it in Part 4.
- **Run events persistence.** Hybrid for v1. Add `run_events` table when reconnect-and-replay becomes a real feature.
- **Pause/resume.** Anthropic's `pause_turn` finishes the Run; restarting from a `pause` state would require persisting model context.
- **Per-Thread sticky model.** Per ADR-0002's resolved decision, no per-Thread sticky in v1.

## What this rejects (and why)

- **Denormalized messages JSON.** Per-message addressing is a near-term need (retry-from-N, edit). Refactoring out of a JSON blob is more painful than starting normalized.
- **Per-token persistence.** No real consumer needs replay yet; the write volume is the cost.
- **Concurrent Runs on the same Thread.** Interleaved Runs on a conversational Thread are undefined behavior; queueing hides the contradiction; failing forces the caller (Part 4 route) to surface a clear error.
- **In-memory Run map without DB persistence.** Earlier "skeleton" framing was reconsidered; the trade-offs of swapping later (eviction policy, message addressing, lost state on restart) outweigh the up-front DDL cost.
- **A separate `audit.db` write per `model.event`.** Audit captures lifecycle, not deltas. Trace logger captures diagnostics. Per-token churn doesn't earn its way into either.
