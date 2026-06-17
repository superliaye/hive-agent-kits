// Editing session — the state machine behind a user's in-progress edit of
// an Agent's bindings. Pure: no React, no fetch. The hook (useAgentEditor)
// owns the React + TanStack Query wiring on top of this.
//
// Conceptually: an EditingSession holds the persisted baseline (what the
// server last told us) and the user's selected desired state. The diff
// against baseline is the pending list. Save sends the diff; reset wipes
// the fork. The session is tied to one Agent — switching agents starts
// a fresh session.

import type { AgentDetail, BindingPatch } from "./api.ts";

export type BindingKind = "skill" | "snippet" | "tool" | "mcp";

export const BINDING_FIELDS: Record<BindingKind, keyof AgentDetail["bindings"]> = {
  skill: "skills",
  snippet: "snippets",
  tool: "tools",
  mcp: "mcp",
};

export type BindingSet = Record<BindingKind, ReadonlySet<string>>;

export type EditingSession = {
  agentId: string;
  // Server's last-known state when this session was opened. Frozen for the
  // life of the session — same-agent SSE refetches do NOT rebaseline (would
  // shift the pending list under the user mid-edit). Only an explicit save
  // or discard refreshes it.
  baseline: BindingSet;
  // The user's desired state. Diverges from baseline as the user toggles.
  selected: BindingSet;
};

export type EditingAction =
  | { type: "toggle"; kind: BindingKind; name: string }
  | { type: "discard" }
  // Use after a successful save or reset: the new server state becomes the
  // baseline AND the selected state.
  | { type: "rebaseline"; agent: AgentDetail };

function bindingsFromAgent(agent: AgentDetail): BindingSet {
  return {
    skill: new Set(agent.bindings.skills),
    snippet: new Set(agent.bindings.snippets),
    tool: new Set(agent.bindings.tools),
    mcp: new Set(agent.bindings.mcp),
  };
}

export function initialSession(agent: AgentDetail): EditingSession {
  const baseline = bindingsFromAgent(agent);
  return { agentId: agent.agentId, baseline, selected: baseline };
}

function toggleIn(set: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

export function sessionReducer(state: EditingSession, action: EditingAction): EditingSession {
  switch (action.type) {
    case "toggle":
      return {
        ...state,
        selected: { ...state.selected, [action.kind]: toggleIn(state.selected[action.kind], action.name) },
      };
    case "discard":
      return { ...state, selected: state.baseline };
    case "rebaseline": {
      const baseline = bindingsFromAgent(action.agent);
      return { agentId: action.agent.agentId, baseline, selected: baseline };
    }
  }
}

// Diff: selected ∖ baseline → bind; baseline ∖ selected → unbind.
export function computePending(session: EditingSession): BindingPatch[] {
  const patches: BindingPatch[] = [];
  for (const kind of Object.keys(BINDING_FIELDS) as BindingKind[]) {
    const baseline = session.baseline[kind];
    const selected = session.selected[kind];
    for (const name of selected) {
      if (!baseline.has(name)) patches.push({ kind, name, action: "bind" });
    }
    for (const name of baseline) {
      if (!selected.has(name)) patches.push({ kind, name, action: "unbind" });
    }
  }
  return patches;
}

export function hasPending(session: EditingSession): boolean {
  return computePending(session).length > 0;
}
