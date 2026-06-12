// Agent role derivation (ADR-0015 §"Backend joins the axes for Worker Agents
// only"; CONTEXT.md "Worker Agent").
//
// A Worker Agent is, by definition, ANY Agent that is not the Root Agent or the
// Agent Manager — the kernel ships exactly two non-Worker agents (CONTEXT.md:57-58,
// 138). There is no `role` field on the HarnessManifest, so the role is DERIVED
// from the well-known kernel ids here, on the daemon (the domain authority). The
// UI never learns these ids; it reads the computed `isWorker` flag off the DTO.

// The two non-Worker kernel agents. Root dispatches; the Agent Manager manages
// lifecycle. Both are always `native` (their built-ins can't run under a CLI),
// so only Workers may switch backend.
const NON_WORKER_AGENT_IDS: ReadonlySet<string> = new Set(["root", "agent-manager"]);

// True iff the agent is a Worker (the default Agent class). Used to gate the
// per-conversation Agent-Backend axis: only Workers may pick a non-native
// backend (enforced at the daemon scope-write port; surfaced to the UI so it
// hides the axis for non-Workers).
export function isWorkerAgent(agentId: string): boolean {
  return !NON_WORKER_AGENT_IDS.has(agentId);
}
