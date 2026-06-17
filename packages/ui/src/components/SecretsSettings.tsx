// SecretsSettings — Settings-page section for Hive credentials.
//
// Two sub-sections:
//   1. Configured — table of stored providers with Remove button.
//   2. API key — provider name + raw apiKey form.
//
// There is no in-app OAuth login (ADR-0019): when no API key is stored, the
// vendor SDKs authenticate from ambient OS login (`claude login` / `codex
// login`). Hive stores API keys only.

import { useCallback, useEffect, useState } from "react";
import { type ApiConfig, api, type ConfiguredProvider } from "../api.ts";

export function SecretsSettings({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [configured, setConfigured] = useState<ConfiguredProvider[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Plain apiKey form state.
  const [apiKeyProvider, setApiKeyProvider] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const confd = await api.listSecrets(apiConfig);
      setConfigured(confd);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [apiConfig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submitApiKey(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!apiKeyProvider.trim() || !apiKeyValue.trim()) return;
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      await api.setApiKey(apiConfig, apiKeyProvider.trim(), apiKeyValue);
      setApiKeyProvider("");
      setApiKeyValue("");
      await refresh();
    } catch (err) {
      setApiKeyError((err as Error).message);
    } finally {
      setApiKeyBusy(false);
    }
  }

  async function removeSecret(provider: string): Promise<void> {
    try {
      await api.removeSecret(apiConfig, provider);
      await refresh();
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  return (
    <>
      {loadError && (
        <div className="banner-error" data-testid="secrets-load-error">
          Failed to load secrets: {loadError}
        </div>
      )}

      <div className="section">
        <h3>Configured</h3>
        {configured.length === 0 ? (
          <p className="empty">
            No credentials stored. Add an API key below, or sign in to the CLI backends directly (
            <code>claude login</code> / <code>codex login</code>).
          </p>
        ) : (
          <table className="secrets-table" data-testid="secrets-configured">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Added</th>
                <th>Refreshed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {configured.map((c) => (
                <tr key={c.provider} data-testid={`secret-row-${c.provider}`}>
                  <td>{c.provider}</td>
                  <td>
                    <span className={`badge badge-${c.kind === "oauth" ? "bundled" : "personal"}`}>
                      {c.kind}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${c.status === "ok" ? "badge-personal" : "badge-workplace"}`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="meta">{formatTimestamp(c.addedAt)}</td>
                  <td className="meta">{c.refreshedAt ? formatTimestamp(c.refreshedAt) : "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => {
                        void removeSecret(c.provider);
                      }}
                      data-testid={`secret-remove-${c.provider}`}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h3>API Key</h3>
        <p className="meta">
          Provider names: <code>anthropic</code>, <code>openai</code>, <code>google</code>,{" "}
          <code>mistral</code>, etc. The key is stored locally in <code>~/.hive/secrets.json</code>.
        </p>
        <form className="api-key-form" onSubmit={submitApiKey} data-testid="api-key-form">
          <input
            type="text"
            placeholder="provider (e.g. anthropic)"
            value={apiKeyProvider}
            onChange={(e) => setApiKeyProvider(e.target.value)}
            disabled={apiKeyBusy}
            data-testid="api-key-provider"
          />
          <input
            type="password"
            placeholder="API key"
            value={apiKeyValue}
            onChange={(e) => setApiKeyValue(e.target.value)}
            disabled={apiKeyBusy}
            data-testid="api-key-value"
          />
          <button
            type="submit"
            className="button"
            disabled={apiKeyBusy || !apiKeyProvider.trim() || !apiKeyValue.trim()}
            data-testid="api-key-submit"
          >
            {apiKeyBusy ? "Saving…" : "Save"}
          </button>
        </form>
        {apiKeyError && (
          <div className="banner-error" data-testid="api-key-error">
            {apiKeyError}
          </div>
        )}
      </div>
    </>
  );
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
