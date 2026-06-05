// SecretsSettings — Settings-page section for Hive credentials.
//
// Three sub-sections:
//   1. Configured — table of stored providers with Remove button.
//   2. OAuth login — buttons for each provider pi-ai's registry exposes
//      (Anthropic, OpenAI Codex, GitHub Copilot, …). Click → SSE stream;
//      on the `auth` event we `openUrl()` the URL so the user's default
//      browser handles the consent screen; on `done` we refresh the list.
//   3. API key — provider name + raw apiKey form. Useful for backend-only
//      providers (OpenAI direct, Mistral, Bedrock) that don't have an OAuth
//      flow yet.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiConfig,
  type ConfiguredProvider,
  type OAuthProvider,
  api,
  openUrl,
} from "../api.ts";

type LoginState =
  | { kind: "idle" }
  | { kind: "starting"; provider: string }
  | {
      kind: "awaiting";
      provider: string;
      authUrl: string;
      authInstructions?: string;
    }
  | { kind: "done"; provider: string }
  | { kind: "error"; provider: string; message: string };

export function SecretsSettings({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [configured, setConfigured] = useState<ConfiguredProvider[]>([]);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState>({ kind: "idle" });
  // Aborts the active login's SSE stream when the user cancels. Only one login
  // runs at a time (the daemon enforces single-flight; the UI mirrors it).
  const loginAbort = useRef<AbortController | null>(null);

  // Plain apiKey form state.
  const [apiKeyProvider, setApiKeyProvider] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [confd, oauth] = await Promise.all([
        api.listSecrets(apiConfig),
        api.listOAuthProviders(apiConfig),
      ]);
      setConfigured(confd);
      setOauthProviders(oauth);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [apiConfig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startOAuth(providerId: string): Promise<void> {
    const controller = new AbortController();
    loginAbort.current = controller;
    setLogin({ kind: "starting", provider: providerId });
    try {
      await api.startOAuthLogin(
        apiConfig,
        providerId,
        (eventName, data) => {
          if (eventName === "auth") {
            const payload = data as { url: string; instructions?: string };
            setLogin({
              kind: "awaiting",
              provider: providerId,
              authUrl: payload.url,
              ...(payload.instructions !== undefined && {
                authInstructions: payload.instructions,
              }),
            });
            // Open the URL in the user's default external browser. Fails
            // silently in plain browser-tab mode (pop-up blocker, etc.) —
            // the URL is also displayed inline for the user to click.
            void openUrl(payload.url).catch(() => {});
          } else if (eventName === "done") {
            setLogin({ kind: "done", provider: providerId });
          } else if (eventName === "error") {
            const payload = data as { message: string };
            setLogin({
              kind: "error",
              provider: providerId,
              message: payload.message,
            });
          }
        },
        controller.signal,
      );
      // After the SSE stream closes successfully, refresh the configured list.
      // (`done` already updated state; refresh pulls the actual row.)
      await refresh();
    } catch (err) {
      // Abort is user-initiated (cancelOAuth already reset state) — not an error.
      if (!controller.signal.aborted) {
        setLogin({ kind: "error", provider: providerId, message: (err as Error).message });
      }
    } finally {
      if (loginAbort.current === controller) loginAbort.current = null;
    }
  }

  function cancelOAuth(): void {
    loginAbort.current?.abort();
    loginAbort.current = null;
    setLogin({ kind: "idle" });
  }

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

  const loginBusy = login.kind === "starting" || login.kind === "awaiting";

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
          <p className="empty">No credentials stored yet. Use OAuth or API Key below.</p>
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
        <h3>OAuth Login</h3>
        {oauthProviders.length === 0 ? (
          <p className="empty">No OAuth providers available.</p>
        ) : (
          <div className="oauth-providers" data-testid="oauth-providers">
            {oauthProviders.map((p) => {
              const configuredEntry = configured.find((c) => c.provider === p.id);
              return (
                <div key={p.id} className="oauth-provider-row">
                  <div>
                    <div className="oauth-provider-name">{p.name}</div>
                    <div className="meta">id: {p.id}</div>
                  </div>
                  <div className="oauth-provider-actions">
                    {configuredEntry && configuredEntry.kind === "oauth" && (
                      <span className="meta" style={{ marginRight: 8 }}>
                        Logged in
                      </span>
                    )}
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        void startOAuth(p.id);
                      }}
                      disabled={loginBusy}
                      data-testid={`oauth-login-${p.id}`}
                    >
                      {configuredEntry?.kind === "oauth" ? "Re-login" : `Log in with ${p.name}`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {login.kind === "starting" && (
          <div className="oauth-status" data-testid="oauth-status">
            <span>
              Starting login for <strong>{login.provider}</strong>…
            </span>
            <button type="button" className="button ghost" onClick={cancelOAuth}>
              Cancel
            </button>
          </div>
        )}
        {login.kind === "awaiting" && (
          <div className="oauth-status" data-testid="oauth-status">
            <span>
              <strong>{login.provider}:</strong>{" "}
              {login.authInstructions ?? "complete the login in your browser, then come back."}{" "}
              <a href={login.authUrl} target="_blank" rel="noopener noreferrer">
                Open the sign-in page
              </a>
            </span>
            <button type="button" className="button ghost" onClick={cancelOAuth}>
              Cancel
            </button>
          </div>
        )}
        {login.kind === "done" && (
          <div className="oauth-status oauth-status-success" data-testid="oauth-status">
            <strong>{login.provider}</strong> linked.
          </div>
        )}
        {login.kind === "error" && (
          <div className="banner-error" data-testid="oauth-status">
            <strong>{login.provider}:</strong> {login.message}
          </div>
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
