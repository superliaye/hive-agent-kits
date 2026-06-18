// PermissionsSettings — Settings-page section for per-agent run_shell command
// allowlists. Read-only view: pick an agent, see its allowlist. Empty/absent ⇒
// deny-all. Editing is a deferred follow-on (no write endpoint here). A separate
// destructive-command floor always applies and is not shown here.

import { useEffect, useState } from "react";
import { type AgentDetail, type AgentSummary, type ApiConfig, api } from "../api.ts";

export function PermissionsSettings({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAgents(apiConfig)
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setSelected((cur) => cur ?? list[0]?.agentId ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiConfig]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .getAgent(apiConfig, selected)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiConfig, selected]);

  const allowlist = detail?.commandAllowlist ?? [];

  return (
    <div className="section">
      <h3>Agent command allowlists</h3>
      <p className="meta">
        The per-agent <code>run_shell</code> allowlist (read-only). An empty allowlist denies all
        commands. A separate destructive-command floor always applies and is not shown here.
      </p>
      {error && (
        <div className="banner-error" data-testid="allowlist-error">
          {error}
        </div>
      )}
      {agents.length > 0 && (
        <select
          className="composer-model-picker"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value)}
          data-testid="allowlist-agent-picker"
          aria-label="Agent"
        >
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.agentId}
            </option>
          ))}
        </select>
      )}
      {allowlist.length === 0 ? (
        <p className="empty" data-testid="allowlist-deny-all">
          deny-all — no commands allowed
        </p>
      ) : (
        <ul className="allowlist" data-testid="allowlist-list">
          {allowlist.map((cmd) => (
            <li key={cmd}>
              <code>{cmd}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
