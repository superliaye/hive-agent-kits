// Pending-changes diff: starts from the agent's persisted bindings, plus
// the user's local toggle state, produces an ordered list of BindingPatches
// that PATCH /api/agents/:id/bindings can apply one at a time.

import type { AgentDetail, BindingPatch } from "./api.ts";

export type BindingKind = "skill" | "snippet" | "tool" | "mcp";
export const BINDING_FIELDS: Record<BindingKind, keyof AgentDetail["bindings"]> = {
  skill: "skills",
  snippet: "snippets",
  tool: "tools",
  mcp: "mcp",
};

// `selected` is the user's full desired state per kind — a Set of names.
// `agent.bindings` is what's currently persisted. We diff: anything in
// selected but not in persisted -> bind; anything in persisted but not
// in selected -> unbind.
export function computePending(
  agent: AgentDetail,
  selected: Record<BindingKind, ReadonlySet<string>>,
): BindingPatch[] {
  const patches: BindingPatch[] = [];
  for (const kind of Object.keys(BINDING_FIELDS) as BindingKind[]) {
    const field = BINDING_FIELDS[kind];
    const current = new Set(agent.bindings[field]);
    const desired = selected[kind];
    for (const name of desired) {
      if (!current.has(name)) patches.push({ kind, name, action: "bind" });
    }
    for (const name of current) {
      if (!desired.has(name)) patches.push({ kind, name, action: "unbind" });
    }
  }
  return patches;
}

export function initialSelected(agent: AgentDetail): Record<BindingKind, Set<string>> {
  return {
    skill: new Set(agent.bindings.skills),
    snippet: new Set(agent.bindings.snippets),
    tool: new Set(agent.bindings.tools),
    mcp: new Set(agent.bindings.mcp),
  };
}

export function togglePresent(set: Set<string>, name: string): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}
