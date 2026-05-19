import type { ApiConfig } from "../api.ts";
import { SecretsSettings } from "../components/SecretsSettings.tsx";

export function SettingsPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  return (
    <div className="detail">
      <h1>Settings</h1>
      <div className="section">
        <h3>Secrets</h3>
        <p className="meta">
          API keys and OAuth credentials for model providers. Used by the Run executor on every Run.
          Stored locally in <code>~/.hive/secrets.json</code> with file mode <code>0600</code>.
        </p>
      </div>
      <SecretsSettings apiConfig={apiConfig} />
      <div className="section">
        <h3>Other</h3>
        <p className="empty">
          Audit retention, UI theme, daemon port, and log level are configurable via{" "}
          <code>~/.hive/config.yaml</code> in v1; UI editor lands in v1.1 per ADR-0006.
        </p>
      </div>
    </div>
  );
}
