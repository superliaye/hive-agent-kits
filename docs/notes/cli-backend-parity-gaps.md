# CLI Agent Backend — parity gaps and open design questions

**Status: analysis, not a decision.** Input for a future "what is a first-class CLI
backend" design pass. Not an ADR — it records *findings*, not a chosen direction.

## Why this exists

A request to let **any** Agent (incl. Root / Agent Manager) run under a CLI backend
agnostically (OpenClaw-style), relaxing ADR-0015's "Worker Agents only" gate, surfaced
that the gate is the cheap part. Digging into the seams (`src/runs/executor.ts`
`runCliBackend` vs `runToolLoop`, `src/runs/tools/cli-invocation.ts`, `permission.ts`,
`audit/subscriptions.ts`) showed the CLI backend is a **thinner integration than
ADR-0016 implies** — several "assembled config" items it describes are not wired. These
gaps already affect the shipped **Worker** CLI backends; the Worker-only gate is just
what currently keeps them off the kernel agents. A relaxation is blocked on closing
them, so the relaxation ADR was parked.

## Native vs CLI orchestrator, as built today

| Concern | `native` | CLI (`claude-code`/`codex`) as built |
|---|---|---|
| Tools | Hive bound tools via `dispatchToolCall` | the CLI's own tools; Hive tools not projected (deferred, ADR-0016 C6) |
| Permission | `commandAllowlist` + destructive-floor, gated per call | **none assembled** — `buildCliInvocation` emits no `--permission-mode`/`--allowedTools`; `commandAllowlist` is **inert** for CLI (the Settings → Backends allowlist UI does not govern a CLI Run) |
| Audit | per-tool events (`run.tool_use.*`, `permission.decided`, `run.skill_loaded`) | **one** event, `backend.spawn.requested` (binary + arg *count*); the CLI's actual tool calls are invisible to Hive audit |
| Model selection | resolved model + effort flow through the ModelGateway | **dropped** — `buildCliInvocation` passes no `--model`; the CLI uses its own configured model, so the composer's model axis does nothing for a CLI backend |
| Orchestration | Root `spawn_sub_agent` → Hive Runs (audited, per-agent Memory) | the CLI's own sub-agent/Task mechanism runs opaquely inside the subprocess — not Hive Runs/agents |
| Prompt | `promptBody` co-designed with the native tools | `promptBody` is `--append-system-prompt`'d verbatim; a native-authored prompt (e.g. Root's "dispatch via `spawn_sub_agent`") references tools the CLI does not have |
| Memory | (future) tool-driven read/write | (future) would need injection + an explicit write-back path; unbuilt in both today |

## Current-shipped implications (already true for Worker CLI backends)

- The **"backend × model" composer picker is misleading for CLI**: picking a model has
  no effect on a CLI Run (model not forwarded).
- The **command-allowlist surface does not govern CLI Runs** — its security meaning is
  native-only.
- **Audit granularity collapses** to "spawned `<cli>` with N args" for a CLI Run.

These are worth a caveat on the Wave-2 PR independent of the relaxation question.

## Open design questions for a first-class CLI backend

1. **Model forwarding.** Pass the resolved model to the CLI (`--model`), and map effort
   to the CLI's reasoning budget — or decide the model axis is native-only and make the
   UI say so.
2. **Permission.** Assemble + control the CLI's permission mode. Decide whether
   `commandAllowlist` maps onto `--allowedTools` (Hive-governed) or the CLI owns
   permission entirely (then the allowlist UI must not imply otherwise).
3. **Audit.** Accept coarse spawn-only audit, or parse the CLI's tool/permission events
   from its JSON stream into Hive audit events (recovering the per-tool record).
4. **Prompt.** A native-authored prompt assumes native tools. Does a CLI Run need a
   backend-aware prompt projection, or a separately authored CLI instruction set?
5. **Orchestration.** Is the CLI's opaque internal sub-tasking acceptable, or must Hive
   dispatch be projected (ties to C6 tool projection) so multi-agent stays Hive-managed?
6. **Memory.** When Memory lands: the injection + write-back contract for a CLI Run.
7. **Agent Manager.** A CLI-backed Agent Manager is incoherent (it can't run lifecycle
   tools and the CLI has no equivalent). Exclude it from any relaxation, or allow it and
   document it as a no-op for management?

## Bearing on the parked relaxation

Relaxing ADR-0015's Worker-only gate is a ~1-day mechanical change (`role.ts`,
`resolve.ts`, `routes.ts`, the UI, tests), but on its own it would expose the gaps above
on the user's **main** agent. Sequencing: settle (1)-(4) at minimum — model forwarding,
the permission contract, the audit story, the prompt question — before the gate is
relaxed, so "use claude-code as your main agent" is coherent rather than half-governed.
