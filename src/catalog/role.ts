// Agent role derivation (CONTEXT.md "Worker Agent"; the Agent-Backend gate per
// ADR-0018).
//
// A Worker Agent is, by definition, ANY Agent that is not the Root Agent or the
// Agent Manager — the kernel ships exactly two non-Worker agents (CONTEXT.md).
// There is no `role` field on the HarnessManifest, so the role is DERIVED from
// the well-known kernel ids here, on the daemon (the domain authority). The
// Agent-Backend gate (`backendAllowedForAgent`) is a separate, narrower rule:
// every Agent may pick a CLI backend EXCEPT the always-native Agent Manager
// (ADR-0018) — it no longer keys off the Worker role.

import type { AgentBackend } from "../lib/capability-types.ts";

// The two kernel agents. Root dispatches; the Agent Manager manages lifecycle.
// Both ship `native`, but only the Agent Manager is native-LOCKED: its
// in-process lifecycle/dispatch built-ins (`create_agent`, `update_agent_harness`,
// `destroy_agent`) cannot run under a CLI. Root MAY pick a CLI backend
// (ADR-0018 relaxes the gate to every agent except the Agent Manager).
const AGENT_MANAGER_ID = "agent-manager";

// True iff the agent is a Worker (the default Agent class — not Root or the
// Agent Manager). Retained as the canonical role-derivation primitive for the
// domain "Worker Agent" (CONTEXT.md). It no longer gates the Agent-Backend axis
// (that gate now excludes only the Agent Manager, per ADR-0018).
export function isWorkerAgent(agentId: string): boolean {
  return agentId !== "root" && agentId !== AGENT_MANAGER_ID;
}

// The domain rule "a non-native backend is permitted for every agent EXCEPT the
// Agent Manager" (ADR-0018 supersedes ADR-0015's "Worker Agents only" clause).
// A clear (`null`) / omitted axis (`undefined`) / `native` is always allowed;
// any concrete CLI backend requires the agent NOT be the always-native Agent
// Manager. The route 409s are fast feedback; `resolve()` is the authoritative
// guard (ADR-0015 §27 / ADR-0018).
export function backendAllowedForAgent(
  agentId: string,
  backend: AgentBackend | null | undefined,
): boolean {
  if (backend === undefined || backend === null || backend === "native") return true;
  return agentId !== AGENT_MANAGER_ID;
}
