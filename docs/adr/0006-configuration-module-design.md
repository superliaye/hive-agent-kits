# Configuration Module Design

## What this ADR records

How **Configuration** works in Hive v1: a reactive central store with synchronous reads, watch-with-initial-fire subscribe semantics, atomic YAML persistence at `~/.hive/config.yaml`, and external-edit hot-reload via a file watcher. Establishes the boundary between Configuration, Agent Harness, and Secrets.

## Shape

```
Module: Config

Verbs:
  get(key)                     → S[key]                            // sync, current value
  set(key, value)              → Promise<void>                     // validate + persist + broadcast
  watch(key, listener)         → () => void                        // disposer; fires immediately with current
```

The interface is three verbs. Behind it: Zod schema validation, in-memory store, atomic disk persistence, file watcher with self-write suppression, change broadcast through a `TypedEmitter`.

`watch()` fires immediately on subscribe with the current value, then again on every change. This eliminates the "initialize from current state, then subscribe to future changes" two-step that callers would otherwise repeat. Standard reactive-store pattern (RxJS `BehaviorSubject`, Solid `signal`, Vue `ref`).

## Single Zod schema for the whole config tree

One top-level schema; nested by domain (`audit`, `ui`, `daemon`, …). Validation is one call. Defaults live alongside the schema and deep-merge into user-provided values at load time.

A flat top-level (no nesting) was rejected — it would inflate every key into a unique name (`auditRetentionDays`, `auditRetentionAutoRotate`, …). Nesting matches how callers think about their slice.

A layered config (VSCode-style default → user → workspace) was rejected for v1: Hive is single-user single-machine; multiple precedence levels add complexity without a current use case. Per-Agent overrides live on the Agent Harness, not as a Config layer.

## Persistence: YAML, atomic writes, file watcher

`~/.hive/config.yaml` is the source of truth on disk. Stored as YAML for human editability. Writes are atomic: write to `config.yaml.tmp`, fsync, rename — never expose a half-written file to the watcher or external readers.

A file watcher (Bun's `fs.watch` / `node:fs.watchFile`) detects external edits. To prevent the watcher from firing on our own writes, the persistence layer maintains a "just wrote at T" timestamp and suppresses events within a small window after our write. External edits (`vim ~/.hive/config.yaml`) re-read, validate, diff against current in-memory state, and emit change events for keys that actually changed.

## What goes in Config — and what does not

| In `config.yaml` | Lives elsewhere |
|---|---|
| Audit retention (autoRotate, days, archiveTo) | API keys, OAuth tokens → **Secrets** primitive |
| UI theme, language | Per-Agent model preference → **Agent Harness** |
| Daemon port, log level | Per-Agent capability bindings → **Agent Harness** |
| Default deployment model | Memory data → per-Agent Memory partition |
| Autonomy default | Per-Agent permission overrides → Harness |
| Feature flags | Capability definitions → `capabilities/` folder |

Config holds deployment-wide settings every component may read. Per-Agent state stays with the Agent. Sensitive values stay in Secrets (which never enter the audit log; Config values do).

## Audit, of course

Configuration changes are auditable events. When the Config module emits a `config.changed` event, the Audit subscriber normalizes it and persists. The audit row captures: what key changed, old value, new value, source (UI / external file edit / programmatic). Free traceability of every settings change including external `vim` edits.

## Build approach — self-contained, tested in isolation

Same pattern as Audit (ADR-0004 "build sequencing"). The Config module lands as a deep module with synthetic-schema tests before any consumer (audit retention scheduler, UI settings page) exists. Tests inject schemas, exercise `get`/`set`/`watch`, and assert on persisted state and event emission. No filesystem mocking — tests use a tmp directory.

## Deferred

- **Schema-driven settings UI generation** (Zod → JSON Schema → form). High-value v1.1 feature. Not blocking.
- **HTTP/WS routes** for the UI to interact with Config — land when the daemon's route layer comes up.
- **Schema migrations** when keys change shape. Add a `version` field at the top of `config.yaml`; loader checks it. For v1, schema is small; defer migration logic until the first actual migration.
- **Layered config** (system / user / workspace). Add only when multiple precedence layers earn it.

## Verification

This ADR is correct if:

1. Reading `config.get("audit.retention.days")` returns the current value synchronously without disk I/O.
2. `config.set(...)` validates with Zod and atomically persists before returning.
3. A `config.watch("audit", listener)` callback fires immediately with the current `audit` subtree, then again on every change.
4. Editing `~/.hive/config.yaml` externally in another editor triggers the same `change` events; modules see the new values.
5. Invalid values are rejected at the `set()` boundary; bad values from external file edits log + retain previous valid state.
6. Audit log contains a row for every `config.changed` event.

If any of these is false, the design is wrong — fix here before further commitments.
