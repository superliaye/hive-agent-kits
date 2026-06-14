# Relax the Worker-only Agent-Backend gate to every Agent except the Agent Manager

---
status: proposed
supersedes-in-part: ADR-0015
extends: ADR-0016
---

## What this records

[ADR-0015](0015-selection-resolution-model.md) added the Agent-Backend axis "for Worker Agents only" — the Root Agent and the Agent Manager were both pinned `native`. With [ADR-0016](0016-cli-backend-projecting-spawn.md)'s projecting spawn built and the CLI-parity gaps closed (model/effort forwarding, the permission contract, the observed-tool audit, and the CLI prompt preamble), the Worker-only restriction now keeps a CLI backend off the **Root Agent** for no remaining technical reason. This ADR relaxes the gate.

## Decision

**A non-native backend is selectable for every Agent EXCEPT the Agent Manager.** The gate predicate (`backendAllowedForAgent`, `src/catalog/role.ts`) drops the "must be a Worker" requirement and keeps exactly one carve-out: `agentId !== "agent-manager"`. `resolve()` (`src/runs/resolve.ts`) stays the authoritative guard — a non-native backend reaching the Agent Manager by any path is neutralized to `native`; the route 409s (model-pref + scope, `reason: "agent_manager_native"`) are fast feedback only. The `isWorker` DTO field is dropped (the UI shows the backend picker for every Agent; the daemon rejects an Agent-Manager CLI pick).

### Q7 — the Agent-Manager carve-out (BINDING)

A CLI-backed Agent Manager is incoherent: its lifecycle built-ins (`create_agent`, `update_agent_harness`, `destroy_agent`) are in-process Hive operations a CLI subprocess cannot invoke. The Agent Manager therefore stays **always native**. This is the single retained guard.

The **Root Agent**, by contrast, *may* run CLI-driven. Root's distinguishing built-in is `spawn_sub_agent` (dispatch); under a CLI that tool is simply unavailable (it is named in the CLI prompt preamble as native-only). Root remains useful as a direct task handler under a CLI — it loses dispatch, not coherence — so there is no reason to native-lock it.

### Residual trade-off: the CLI is half-governed vs native

Phase 1 closed the parity gaps coarsely. On the dimensions it left coarse, a CLI Run is governed less tightly than a native Run, and relaxing the gate to Root widens who is exposed to that:

- **Permission** is Bash-scoped only. Hive's `commandAllowlist` projects onto the CLI's allowed *Bash* tools under a `--permission-mode default` floor; the CLI's non-Bash tools (Edit/Read/etc.) stay CLI-governed.
- **Audit** is observed-after-the-fact, not gated-before. `backend.tool_use.observed` records the tool *name* recovered from the CLI's event stream after it ran; the CLI owns the gate. There is no per-decision permission-audit parity — the CLI exposes only an end-of-run `permission_denials[]` array, not per-decision events.

These are accepted for v1 and recorded here so the gap is explicit rather than silent.

### Q5 — orchestration: document-defer (BINDING)

We do **not** build dispatch projection (a CLI sub-tasking → Hive-Run/audit bridge) now. v1 **accepts opaque CLI internal sub-tasking**: when a CLI backend spawns its own sub-agents, that work is invisible to Hive's Runs and audit. This is the residual trade-off of relaxing the gate to Root specifically (Root is the dispatch orchestrator), and it is consistent with [ADR-0016](0016-cli-backend-projecting-spawn.md)'s deferral of Tool/MCP projection. A future ADR may project CLI sub-tasking into Hive Runs.

### Q6 — Memory: defer (BINDING)

Memory is **unbuilt in both backends today**, so there is no parity gap to close and no contract to design now. The intended future shape, recorded for when Memory lands: a CLI Run should receive the Agent's Memory **injected** at spawn (read) and have CLI-produced Memory **written back** at Run end, mirroring the native path — so Memory continuity does not depend on which backend ran the Thread.

## Why

The Worker-only gate predated the projecting spawn and the parity work; it was a conservative placeholder, not a considered restriction on Root. Keeping it would block a legitimate use (run Root under a CLI as a direct handler) to avoid a problem that does not exist (Root's lifecycle coherence — it has none to lose; only the Agent Manager does). The single real constraint is the Agent Manager's in-process lifecycle built-ins, so that is the only guard retained.

## Consequences

- Root and every Worker can pick `native` or a CLI backend per conversation, promotable to the Agent default; the Agent Manager cannot.
- The `isWorker` daemon DTO field and the `worker_only` 409 reason are gone; the role primitive `isWorkerAgent` survives as the canonical "Worker Agent" derivation (CONTEXT.md).
- Opaque CLI sub-tasking and the half-governed-vs-native dimensions are accepted v1 trade-offs, to be revisited if/when dispatch projection and the Memory contract are built.
