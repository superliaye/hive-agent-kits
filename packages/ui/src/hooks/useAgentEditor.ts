// useAgentEditor — the React hook that wires the pure EditingSession state
// machine to TanStack Query mutations and the daemon API. The component
// consuming this hook becomes pure rendering.
//
// Session policy: a session is bound to one agentId. Switching agents
// starts a fresh session. Same-agent SSE-driven refetches do NOT
// rebaseline — only an explicit save/discard does. This preserves the
// user's in-progress edits when external changes land (single-user
// trade-off; documented in ADR-0007 follow-up if multi-surface becomes
// real).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer } from "react";
import { api, type AgentDetail, type ApiConfig } from "../api.ts";
import {
  type BindingKind,
  type BindingSet,
  computePending,
  initialSession,
  sessionReducer,
} from "../editing-session.ts";

export type AgentEditor = {
  selected: BindingSet;
  pending: ReturnType<typeof computePending>;
  hasPending: boolean;
  isSaving: boolean;
  isResetting: boolean;
  toggle: (kind: BindingKind, name: string) => void;
  discard: () => void;
  save: () => void;
  reset: () => void;
};

export function useAgentEditor(apiConfig: ApiConfig, agent: AgentDetail): AgentEditor {
  const qc = useQueryClient();
  const [session, dispatch] = useReducer(sessionReducer, agent, initialSession);

  // Switching agents = fresh session. Same-agent refetches intentionally
  // do not rebaseline (see policy comment above).
  useEffect(() => {
    if (session.agentId !== agent.agentId) {
      dispatch({ type: "rebaseline", agent });
    }
  }, [agent, session.agentId]);

  const pending = useMemo(() => computePending(session), [session]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["agents", agent.agentId] });
  };

  const saveMutation = useMutation({
    mutationFn: () => api.patchBindings(apiConfig, agent.agentId, pending),
    onSuccess: (updated) => {
      // Rebaseline to the just-saved state so the pending list clears.
      dispatch({ type: "rebaseline", agent: updated });
      invalidate();
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.resetAgent(apiConfig, agent.agentId),
    onSuccess: (updated) => {
      dispatch({ type: "rebaseline", agent: updated });
      invalidate();
    },
  });

  return {
    selected: session.selected,
    pending,
    hasPending: pending.length > 0,
    isSaving: saveMutation.isPending,
    isResetting: resetMutation.isPending,
    toggle: (kind, name) => dispatch({ type: "toggle", kind, name }),
    discard: () => dispatch({ type: "discard" }),
    save: () => saveMutation.mutate(),
    reset: () => resetMutation.mutate(),
  };
}
