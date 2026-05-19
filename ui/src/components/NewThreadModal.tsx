// NewThreadModal — agent picker for creating a new Thread. Loads
// `catalog.list()` and shows each Agent as a clickable card. On confirm,
// calls `onCreate(agentId)` which the caller wires to POST /api/threads.

import { useEffect, useState } from "react";
import { type AgentSummary, type ApiConfig, api } from "../api.ts";

export function NewThreadModal({
  apiConfig,
  onClose,
  onCreate,
}: {
  apiConfig: ApiConfig;
  onClose: () => void;
  onCreate: (agentId: string) => Promise<void>;
}): JSX.Element {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAgents(apiConfig)
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiConfig]);

  async function pick(agentId: string): Promise<void> {
    setBusy(true);
    try {
      await onCreate(agentId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    // Backdrop click closes the modal. We use `e.target === e.currentTarget`
    // instead of stopPropagation on the inner modal — that way the click
    // handler only fires for backdrop clicks, and the inner content needs
    // no event-blocking handler. Keyboard: Escape closes.
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      data-testid="new-thread-modal"
    >
      <div className="modal">
        <div className="modal-header">
          <h2>New Thread</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="meta">Pick an agent to start the conversation with.</p>
        {error && (
          <div className="banner-error" data-testid="new-thread-error">
            {error}
          </div>
        )}
        {agents === null ? (
          <p className="empty">Loading agents…</p>
        ) : agents.length === 0 ? (
          <p className="empty">No agents available. Configure one in Agents tab first.</p>
        ) : (
          <ul className="agent-picker" data-testid="agent-picker">
            {agents.map((a) => (
              <li key={a.agentId}>
                <button
                  type="button"
                  className="agent-picker-item"
                  onClick={() => {
                    void pick(a.agentId);
                  }}
                  disabled={busy}
                  data-testid={`agent-pick-${a.agentId}`}
                >
                  <div className="agent-picker-name">{a.agentId}</div>
                  <div className="agent-picker-meta meta">
                    {a.domain} · backend: {a.backend}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
