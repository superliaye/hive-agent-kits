// BackendsSettings — Settings-page section for detected CLI agent backends
// (ADR-0016 "detect, don't manage"). Hive detects each CLI's health + version
// and DELEGATES updates to the CLI's own updater — it never installs or manages
// packages itself.
//
// Two sub-sections:
//   1. Backends — health table (status / version / last checked). An installed
//      backend gets an Update button (delegates to the CLI's own updater, then
//      re-probes); a missing one shows install guidance (no Hive install action).
//      A Re-check button (re-probe only) is always present.
//   2. Agent command allowlists — read-only view of an agent's run_shell
//      allowlist (OQ-7, render-only this slice). Empty ⇒ deny-all.

import { useCallback, useEffect, useState } from "react";
import {
  type AgentDetail,
  type AgentSummary,
  type ApiConfig,
  type BackendStatus,
  api,
} from "../api.ts";

// reason → badge tone. ok = healthy (personal/green); not_installed = neutral
// (bundled); every failure reason = workplace/red.
function reasonTone(reason: BackendStatus["reason"]): string {
  if (reason === "ok") return "badge-personal";
  if (reason === "not_installed") return "badge-bundled";
  return "badge-workplace";
}

type RowBusy = { kind: "idle" } | { kind: "updating" } | { kind: "rechecking" };

export function BackendsSettings({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [statuses, setStatuses] = useState<BackendStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, RowBusy>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatuses(await api.listBackends(apiConfig));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [apiConfig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function update(backend: "claude-code" | "codex"): Promise<void> {
    setBusy((b) => ({ ...b, [backend]: { kind: "updating" } }));
    setRowError((e) => {
      const { [backend]: _drop, ...rest } = e;
      return rest;
    });
    try {
      // Delegate to the CLI's own updater; the endpoint re-probes and returns
      // the fresh status, which we splice into the row.
      const fresh = await api.upgradeBackend(apiConfig, backend);
      setStatuses((list) => list.map((s) => (s.backend === backend ? fresh : s)));
      // Re-probe the full set so a sibling backend's row stays current too.
      await refresh();
    } catch (err) {
      setRowError((e) => ({ ...e, [backend]: (err as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [backend]: { kind: "idle" } }));
    }
  }

  async function recheck(backend: "claude-code" | "codex"): Promise<void> {
    setBusy((b) => ({ ...b, [backend]: { kind: "rechecking" } }));
    // Mirror update(): drop any stale per-row error so a now-healthy re-probe
    // clears the banner a prior failed Update left behind.
    setRowError((e) => {
      const { [backend]: _drop, ...rest } = e;
      return rest;
    });
    try {
      await refresh();
    } finally {
      setBusy((b) => ({ ...b, [backend]: { kind: "idle" } }));
    }
  }

  return (
    <>
      {loadError && (
        <div className="banner-error" data-testid="backends-load-error">
          Failed to load backends: {loadError}
        </div>
      )}

      <div className="section">
        <h3>Backends</h3>
        <p className="meta">
          Hive detects each CLI agent backend and delegates updates to the CLI's own updater. Hive
          does not install or manage these CLIs.
        </p>
        {statuses.length === 0 ? (
          <p className="empty">No CLI backends detected.</p>
        ) : (
          <table className="secrets-table" data-testid="backends-table">
            <thead>
              <tr>
                <th>Backend</th>
                <th>Status</th>
                <th>Version</th>
                <th>Checked</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => {
                const rowBusy = busy[s.backend]?.kind ?? "idle";
                const disabled = rowBusy !== "idle";
                return (
                  <tr key={s.backend} data-testid={`backend-row-${s.backend}`}>
                    <td>{s.backend}</td>
                    <td>
                      <span className={`badge ${reasonTone(s.reason)}`}>{s.reason}</span>
                    </td>
                    <td className="meta">{s.version ?? "—"}</td>
                    <td className="meta">{formatTimestamp(s.checkedAt)}</td>
                    <td>
                      {s.reason === "not_installed" ? (
                        <span className="meta" data-testid={`backend-install-${s.backend}`}>
                          Install {s.backend} from its own distribution, then re-check.
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="button"
                          onClick={() => void update(s.backend)}
                          disabled={disabled}
                          data-testid={`backend-update-${s.backend}`}
                        >
                          {rowBusy === "updating" ? "Updating…" : "Update via the CLI's own updater"}
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        className="button ghost"
                        onClick={() => void recheck(s.backend)}
                        disabled={disabled}
                        data-testid={`backend-recheck-${s.backend}`}
                      >
                        {rowBusy === "rechecking" ? "Re-checking…" : "Re-check"}
                      </button>
                      {rowError[s.backend] && (
                        <div className="banner-error" data-testid={`backend-error-${s.backend}`}>
                          {rowError[s.backend]}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <AgentAllowlistPanel apiConfig={apiConfig} />
    </>
  );
}

// Read-only view of an agent's run_shell command allowlist (OQ-7). Pick an
// agent; show its allowlist. Empty/absent ⇒ a deny-all label matching the gate
// semantics. Editing is a deferred follow-on — no write endpoint here.
function AgentAllowlistPanel({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
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

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
