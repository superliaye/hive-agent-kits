// Agent role derivation (CONTEXT.md "Worker Agent").
//
// A Worker Agent is, by definition, ANY Agent that is not the Root Agent or the
// Agent Manager — the kernel ships exactly two non-Worker agents (CONTEXT.md).
// There is no `role` field on the HarnessManifest, so the role is DERIVED from
// the well-known kernel ids here, on the daemon (the domain authority).
//
// There is no Agent-Backend gate (ADR-0019, resolving ADR-0018): every Agent —
// including the Agent Manager — runs on whichever SDK backend its harness/prefs
// resolve to. The AM performs lifecycle ops through the MCP-projected lifecycle
// tools.

const AGENT_MANAGER_ID = "agent-manager";

// True iff the agent is a Worker (the default Agent class — not Root or the
// Agent Manager). The canonical role-derivation primitive for the domain
// "Worker Agent" (CONTEXT.md).
export function isWorkerAgent(agentId: string): boolean {
  return agentId !== "root" && agentId !== AGENT_MANAGER_ID;
}
