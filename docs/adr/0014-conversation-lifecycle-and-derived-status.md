# Conversation lifecycle and derived Thread status

## What this ADR records

How a **Thread** (a _conversation_ in the UI) is shaped over its life and surfaced for display: that there is no context-reset (only an archival lifecycle), how its title is chosen and made sticky, how its four-state status is derived rather than stored, how the Thread list is paged and sorted, how stale Threads are auto-archived, and which Thread events are audited versus traced. These decisions landed across the threads-daemon phases; this ADR captures the trade-offs behind them.

## Context

The conversation surface needed answers to several questions at once: does Hive ever trim or reset a conversation to save tokens; who names a Thread and when; how does the list show "this one has a reply waiting" versus "this one failed"; how is that status kept correct without a column to drift; how is a long list of Threads presented; what happens to conversations nobody touches; and which of these movements are user decisions worth auditing. Each had a tempting shortcut (a truncation knob, a status column, a one-shot title flag, a cron) that traded long-term clarity for short-term simplicity.

## Decision

### 1. Archival lifecycle, no context-reset

A Thread is always _active_, _archived_, or _deleted_. There is no truncation, summarization-down, or reset path: a Run always receives the full conversation history. The only ways a conversation leaves the active list are archive (reversible, fully readable) and delete (gone).

Trade-off: this gives a simpler mental model and a clean audit/portability story — the full conversation is always the source of truth — at the cost of a token-saving truncation knob. Hard to reverse: it shapes the whole conversation data model and the UI affordances built on top of it, which is why it is recorded as an explicit "no" rather than left implicit.

### 2. Title-source stickiness with daemon-side, once-per-untitled auto-generation

A Thread's **Title Source** is `manual` or `auto`; a `manual` title is never overwritten by automatic generation. Automatic titling is best-effort and runs daemon-side, invoked from the run route after the terminal completed event drains — not inside the executor, which stays a pure model-loop. The renderer cannot do it (it has no gateway or auth), so the daemon owns generation. Generation is gated on the Thread still being untitled and auto-sourced and having at least one completed exchange; a title-presence guard (rather than a persisted attempt flag) makes it idempotent and resilient: an interrupted first exchange still leaves the Thread untitled, so a later completed exchange backfills the title, and once any title exists generation stops permanently. Keeping the call on the streaming hook preserves ADR-0004's audit-first emit-before-persist ordering.

Trade-off: a route-side side-effect against a strictly pure executor, and idempotency via title-presence against a persisted attempt flag. The title-presence guard is what buys the disconnect/failure resilience for free.

### 3. Four-state derived status (idle / running / unread / failed)

A Thread's display status is computed daemon-side from in-flight Runs plus the newest terminal Run's outcome plus a persisted last-read time, in precedence _running > failed > unread > idle_. A newest-terminal Run that failed or was cancelled and is still unseen surfaces as _failed_ (split out of _unread_) and clears when the user reads the conversation. Status is live-pushed to the renderer over `/api/events` on the run-lifecycle events; the terminal events were widened to carry the Thread (and Agent) identity so a single event stream drives the list.

Trade-off: deriving on read is always correct and needs no status column to keep in sync, at the cost of recomputation; widening the existing terminal events avoids a separate thread-changed event at the cost of fatter run events. Surprising without context: status is _not_ stored, and a fourth state (failed) was split out of unread rather than folded into it.

### 4. Client-bucketed pagination, archived-last, grouped by Agent

The daemon returns the full unfiltered Thread list; the renderer pages it (a fixed initial page, then Load-more / Load-archived), sorts non-archived first and then by last-interaction descending within each bucket, and groups by Agent.

Trade-off: client-side bucketing of one unfiltered list keeps the daemon endpoint trivial and the sort/group logic co-located with the view, at the cost of shipping the whole list rather than server-side paged endpoints. Acceptable while per-deployment Thread counts are modest; revisit if a deployment's list grows large enough that transferring all of it hurts.

### 5. Auto-archive as a boot sweep, trace-only

Threads untouched for roughly two months are archived by a sweep at daemon boot, not by an always-on scheduler. Because it is housekeeping and not a user decision, it is traced, not audited.

Trade-off: a boot-time sweep against a standing cron — simpler, with no scheduler to own, at the cost of only running when the daemon starts; trace against audit, on the principle that a system-initiated housekeeping move is not a user-proximate action.

### 6. Threads as an audited source for user-driven actions only

The Thread module is an Audit subscribe-source (ADR-0004). It emits typed events for the user-driven movements — manual archive, delete, manual title-set, mark-unread — audit-first and refs-not-values: payloads carry Thread/Agent identity and the title source, never the title string. The two system-initiated movements, auto-archive and auto-title-generation, are traced, not audited.

Trade-off: the line drawn here is which Thread events are user-proximate (audit) versus system-observed (trace). Drawing it wrong would either bury user decisions in trace or pollute the audit log with housekeeping; the split follows the "was a user the proximate cause?" test.

The Phase-2 `resolveAgentModel` extraction left ADR-0013's model/effort resolution tiers intact; nothing here contradicts it.

## Consequences

- The full conversation is always the model's input and the audit source of truth; there is no truncation state to reason about, but also no built-in token-saving knob.
- Status is correct by construction (no column to drift) and updates live, at the cost of being recomputed per read and of fatter terminal run events.
- Automatic titling self-heals across interruptions and never fights a user's chosen title, with no attempt-flag bookkeeping.
- The Thread list logic lives client-side; growing very large deployments is the known pressure point on the single-list transfer.
- Reversal cost is high for decisions 1 and 3 (they shape the data model and the event contract) and moderate for the rest. Recorded here because "why no context-reset", "why status is derived not stored", and "why a fourth failed state" are non-obvious without the trade-offs above.
