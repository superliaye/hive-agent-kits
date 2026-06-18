// BackendsSettings — one card per Agent Backend (ADR-0016 "detect, don't
// manage"; ADR-0019 no in-app OAuth flow). Each card joins a Health zone (the
// probe: version / checked time, with CLI-delivered update + re-check) and an
// Auth zone (the backend's Secret auth state), read from the server-side
// Backend Readiness projection.
//
// Auth honesty: only an API key is OPERATIVE — it is the sole credential Hive
// injects into a Run. A stored CLI sign-in (OAuth) is what the Run uses when no
// Hive key is present; the card states that plainly rather than claiming a
// verified Hive-side sign-in.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiConfig, api, type BackendReadiness, type BackendStatus } from "../api.ts";

// Friendly display name per backend. Internal ids stay machine-named; this is
// copy only.
function friendlyName(backend: BackendStatus["backend"]): string {
  return backend === "claude-code" ? "Claude Code" : "Codex";
}

// Readiness verdict — a human-facing answer derived in the UI from the probe
// health + the auth state. Presentation only; the daemon shape is unchanged.
type ReadinessVerdict = {
  label: "Ready" | "Using CLI sign-in" | "Not installed" | "Error";
  className: string;
  icon: JSX.Element;
};

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.5 8.5l3 3 6-6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 12L12 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ErrorIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.5 5.5l5 5M10.5 5.5l-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TerminalIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 4.5l3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 11h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function deriveReadinessVerdict(row: BackendReadiness): ReadinessVerdict {
  if (!row.installed || row.reason === "not_installed") {
    return { label: "Not installed", className: "badge-not-installed", icon: <DashIcon /> };
  }
  // probe_failed (non-zero exit) and timeout (no response in budget) mean the
  // probe couldn't confirm a usable CLI — a genuine error. version_unreadable is
  // deliberately NOT here: the binary ran cleanly, only its --version output
  // didn't parse, so it's usable — fall through to the auth verdict (the version
  // just renders as "—").
  if (row.reason === "probe_failed" || row.reason === "timeout") {
    return { label: "Error", className: "badge-error", icon: <ErrorIcon /> };
  }
  if (row.auth.state === "api-key") {
    return { label: "Ready", className: "badge-ready", icon: <CheckIcon /> };
  }
  // cli-managed → Hive defers to the CLI's own login. A NEUTRAL state, never an
  // alarm: Hive deliberately can't read the CLI login to verify it, so it cannot
  // assert an auth problem. A stored OAuth token — even expired — does NOT change
  // this: it's display-only, never injected into a run, and `<cli> login` can't
  // refresh a Hive-stored token anyway, so it must never drive "Action needed".
  return { label: "Using CLI sign-in", className: "badge-cli", icon: <TerminalIcon /> };
}

type RowBusy = { kind: "idle" } | { kind: "updating" } | { kind: "rechecking" };

export function BackendsSettings({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [rows, setRows] = useState<BackendReadiness[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, RowBusy>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  // Switching Settings sections unmounts this component; an in-flight readiness
  // fetch (initial load or a post-update re-probe) must not write state after
  // unmount. The ref gates every async resolution back into React state.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getBackendsReadiness(apiConfig);
      if (!mounted.current) return;
      setRows(next);
      setLoadError(null);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError((err as Error).message);
    }
  }, [apiConfig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setBusyFor = useCallback((backend: string, next: RowBusy): void => {
    setBusy((b) => ({ ...b, [backend]: next }));
  }, []);

  const clearRowError = useCallback((backend: string): void => {
    setRowError((e) => {
      const { [backend]: _drop, ...rest } = e;
      return rest;
    });
  }, []);

  async function update(backend: "claude-code" | "codex"): Promise<void> {
    setBusyFor(backend, { kind: "updating" });
    clearRowError(backend);
    try {
      // Delegate to the CLI's own updater; then re-fetch the full readiness set
      // so the updated row (and any sibling) reflects the fresh probe + auth.
      await api.upgradeBackend(apiConfig, backend);
      await refresh();
    } catch (err) {
      if (mounted.current) setRowError((e) => ({ ...e, [backend]: (err as Error).message }));
    } finally {
      if (mounted.current) setBusyFor(backend, { kind: "idle" });
    }
  }

  async function recheck(backend: "claude-code" | "codex"): Promise<void> {
    setBusyFor(backend, { kind: "rechecking" });
    clearRowError(backend);
    try {
      await refresh();
    } finally {
      if (mounted.current) setBusyFor(backend, { kind: "idle" });
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
          Hive runs agents through the Claude Code and Codex CLIs on your machine — it detects and
          updates them, but doesn't install them. If you've signed in to a CLI (
          <code>claude login</code> / <code>codex login</code>), Hive uses that automatically; you
          only need an API key if you'd rather not sign in to the CLI.
        </p>
        {rows.length === 0 ? (
          <p className="empty">No CLI backends detected.</p>
        ) : (
          rows.map((row) => (
            <BackendCard
              key={row.backend}
              row={row}
              busy={busy[row.backend]?.kind ?? "idle"}
              error={rowError[row.backend]}
              onUpdate={() => void update(row.backend)}
              onRecheck={() => void recheck(row.backend)}
              onAuthChanged={() => void refresh()}
              onAuthError={(msg) => setRowError((e) => ({ ...e, [row.backend]: msg }))}
              apiConfig={apiConfig}
            />
          ))
        )}
      </div>
    </>
  );
}

function BackendCard({
  row,
  busy,
  error,
  onUpdate,
  onRecheck,
  onAuthChanged,
  onAuthError,
  apiConfig,
}: {
  row: BackendReadiness;
  busy: RowBusy["kind"];
  error: string | undefined;
  onUpdate: () => void;
  onRecheck: () => void;
  onAuthChanged: () => void;
  onAuthError: (message: string) => void;
  apiConfig: ApiConfig;
}): JSX.Element {
  const disabled = busy !== "idle";
  const name = friendlyName(row.backend);
  const verdict = deriveReadinessVerdict(row);
  // Single source of truth: the verdict already encodes the not-installed state.
  const notInstalled = verdict.label === "Not installed";

  return (
    <div
      className="card backend-card"
      data-testid={`backend-card-${row.backend}`}
      aria-busy={disabled}
    >
      <div className="backend-card-header">
        <span className="backend-card-title">
          <span className="backend-card-name">{name}</span>
          <span className="backend-card-id">{row.backend}</span>
        </span>
        <span
          className={`badge badge-readiness ${verdict.className}`}
          data-testid={`backend-readiness-${row.backend}`}
        >
          {verdict.icon}
          {verdict.label}
        </span>
      </div>

      {/* Health zone */}
      <div className="backend-card-health" data-testid={`backend-health-${row.backend}`}>
        <span className="meta">Version: {row.version ?? "—"}</span>{" "}
        <span className="meta">Checked: {formatTimestamp(row.checkedAt)}</span>
        <div className="backend-card-actions">
          {notInstalled ? (
            <span className="meta" data-testid={`backend-install-${row.backend}`}>
              Install {name} from its own distribution, then re-check.
            </span>
          ) : (
            <button
              type="button"
              className="button ghost"
              onClick={onUpdate}
              disabled={disabled}
              title={`Update ${name} through its own CLI updater`}
              aria-label={`Update ${name}`}
              data-testid={`backend-update-${row.backend}`}
            >
              {busy === "updating" ? "Updating…" : "Update"}
            </button>
          )}
          <button
            type="button"
            className="button ghost"
            onClick={onRecheck}
            disabled={disabled}
            aria-label={`Re-check ${name}`}
            data-testid={`backend-recheck-${row.backend}`}
          >
            {busy === "rechecking" ? "Re-checking…" : "Re-check"}
          </button>
        </div>
        {error && (
          <div className="banner-error" data-testid={`backend-error-${row.backend}`}>
            {error}
          </div>
        )}
      </div>

      {/* Auth zone */}
      <BackendAuthRow
        row={row}
        notInstalled={notInstalled}
        apiConfig={apiConfig}
        onChanged={onAuthChanged}
        onError={onAuthError}
      />
    </div>
  );
}

function BackendAuthRow({
  row,
  notInstalled,
  apiConfig,
  onChanged,
  onError,
}: {
  row: BackendReadiness;
  notInstalled: boolean;
  apiConfig: ApiConfig;
  onChanged: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [showKeyForm, setShowKeyForm] = useState(false);
  const provider = row.provider;
  const name = friendlyName(row.backend);

  async function remove(): Promise<void> {
    try {
      // Remove writes the row's mapped provider only — never a free-text value.
      await api.removeSecret(apiConfig, provider);
      onChanged();
    } catch (err) {
      onError((err as Error).message);
    }
  }

  const isApiKey = row.auth.state === "api-key";
  const stored = row.auth.stored;
  const storedOauth = stored?.kind === "oauth";

  // Not installed: suppress all auth setup. Only a leftover stored credential
  // stays visible (and removable). No Set/Replace form, no sign-in paragraph.
  if (notInstalled) {
    if (!stored) {
      return <div className="backend-card-auth" data-testid={`backend-auth-${row.backend}`} />;
    }
    return (
      <div className="backend-card-auth" data-testid={`backend-auth-${row.backend}`}>
        <span className="meta" data-testid={`backend-auth-leftover-${row.backend}`}>
          Hive is still holding a saved {name} sign-in from before, but {name} isn't installed, so
          it's unused. Removing it is safe — it won't affect your machine's own {name} login.
        </span>
        <div className="backend-card-actions">
          <button
            type="button"
            className="button ghost"
            onClick={() => void remove()}
            aria-label={`Remove stored credential for ${name}`}
            data-testid={`backend-auth-remove-${row.backend}`}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="backend-card-auth" data-testid={`backend-auth-${row.backend}`}>
      {isApiKey ? (
        <>
          <span className="meta" data-testid={`backend-auth-apikey-${row.backend}`}>
            API key set — Hive uses it for runs.
          </span>
          <div className="backend-card-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => setShowKeyForm((s) => !s)}
              aria-label={`Replace API key for ${name}`}
              data-testid={`backend-auth-replace-${row.backend}`}
            >
              Replace
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => void remove()}
              aria-label={`Remove API key for ${name}`}
              data-testid={`backend-auth-remove-${row.backend}`}
            >
              Remove
            </button>
          </div>
        </>
      ) : storedOauth ? (
        <>
          <span className="meta" data-testid={`backend-auth-oauth-${row.backend}`}>
            Hive uses your {name} CLI sign-in for runs. A leftover sign-in token is also stored here
            but isn't used — running <code>{loginHint(row.backend)}</code> refreshes the CLI's own
            login, not this stored copy, so just remove it.
          </span>
          <div className="backend-card-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => void remove()}
              aria-label={`Remove stored credential for ${name}`}
              data-testid={`backend-auth-remove-${row.backend}`}
            >
              Remove
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => setShowKeyForm((s) => !s)}
              aria-label={`Use an API key for ${name} instead`}
              data-testid={`backend-auth-setkey-${row.backend}`}
            >
              Use an API key instead
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="meta" data-testid={`backend-auth-cli-${row.backend}`}>
            Hive uses your {name} CLI sign-in for runs. If you've run{" "}
            <code>{loginHint(row.backend)}</code>, you're set — Hive can't read your CLI login to
            confirm it.
          </span>
          <div className="backend-card-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => setShowKeyForm((s) => !s)}
              aria-label={`Use an API key for ${name} instead`}
              data-testid={`backend-auth-setkey-${row.backend}`}
            >
              Use an API key instead
            </button>
          </div>
        </>
      )}

      {showKeyForm && (
        <ApiKeyForm
          provider={provider}
          backendName={name}
          apiConfig={apiConfig}
          onSaved={() => {
            setShowKeyForm(false);
            onChanged();
          }}
          onError={onError}
          testIdSuffix={row.backend}
        />
      )}
    </div>
  );
}

// Per-backend key form. Writes ONLY the card's mapped provider — no free-text
// provider input, so it cannot create orphan secrets.
function ApiKeyForm({
  provider,
  backendName,
  apiConfig,
  onSaved,
  onError,
  testIdSuffix,
}: {
  provider: string;
  backendName: string;
  apiConfig: ApiConfig;
  onSaved: () => void;
  onError: (message: string) => void;
  testIdSuffix: string;
}): JSX.Element {
  // Uncontrolled: the key is read from the input on submit. A raw secret never
  // needs to live in React state, and this keeps the field a plain DOM input.
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const key = inputRef.current?.value.trim() ?? "";
    if (!key) return;
    setBusy(true);
    try {
      await api.setApiKey(apiConfig, provider, key);
      if (inputRef.current) inputRef.current.value = "";
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="api-key-form"
      onSubmit={submit}
      data-testid={`backend-key-form-${testIdSuffix}`}
    >
      <span className="meta">
        Stored locally in <code>~/.hive/secrets.json</code>.
      </span>
      <input
        ref={inputRef}
        type="password"
        placeholder="API key"
        disabled={busy}
        aria-label={`API key for ${backendName}`}
        data-testid={`backend-key-value-${testIdSuffix}`}
      />
      <button
        type="submit"
        className="button"
        disabled={busy}
        data-testid={`backend-key-submit-${testIdSuffix}`}
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function loginHint(backend: BackendStatus["backend"]): string {
  return backend === "claude-code" ? "claude login" : "codex login";
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
