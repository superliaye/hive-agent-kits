import { ShellConnectionMetadata } from "@hive/contract";
import { useEffect, useState } from "react";
import type { ApiConfig } from "./api.ts";
import { KitDeployPage } from "./pages/KitDeployPage.tsx";
import { type SectionId, SettingsPage } from "./pages/SettingsPage.tsx";

type Page = "capabilities" | "settings";

function connectionSnapshot(): ShellConnectionMetadata | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.__hive?.getConnection?.() ?? window.__hive?.connection;
  const parsed = ShellConnectionMetadata.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export default function App({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [page, setPage] = useState<Page>("capabilities");
  const [settingsSection, setSettingsSection] = useState<SectionId>("appearance");
  const [connection, setConnection] = useState(connectionSnapshot);

  useEffect(() => {
    const changed = (event: Event): void => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const parsed = ShellConnectionMetadata.safeParse(detail);
      setConnection(parsed.success ? parsed.data : connectionSnapshot());
    };
    window.addEventListener("hive:connection-changed", changed);
    return () => window.removeEventListener("hive:connection-changed", changed);
  }, []);

  const mutationsDisabled = connection !== undefined && connection.status !== "connected";

  return (
    <div className="app">
      <div className="tabs">
        <button
          type="button"
          className={`tab ${page === "capabilities" ? "active" : ""}`}
          onClick={() => setPage("capabilities")}
          data-testid="tab-capabilities"
        >
          Capabilities
        </button>
        <button
          type="button"
          className={`tab ${page === "settings" ? "active" : ""}`}
          onClick={() => setPage("settings")}
          data-testid="tab-settings"
        >
          Settings
        </button>
      </div>
      {connection?.status === "reauthentication_required" && (
        <div className="banner-error" data-testid="kit-reauthentication-required" role="alert">
          The external Hive session expired or was revoked. Close Hive and relaunch the external
          connection to continue.
        </div>
      )}
      {connection?.status === "disconnected" && (
        <div className="banner-warn" data-testid="hive-connection-disconnected" role="status">
          The Hive connection is unavailable. Retrying automatically…
        </div>
      )}
      <div className="body">
        {/* Kept mounted (not conditionally rendered) so the in-session deploy
            selection survives leaving and returning to the tab; display:contents
            keeps .kit-page as the direct flex child of .body when visible. */}
        <div style={{ display: page === "capabilities" ? "contents" : "none" }}>
          <KitDeployPage apiConfig={apiConfig} connection={connection} />
        </div>
        {page === "settings" && (
          <fieldset className="settings-connection-gate" disabled={mutationsDisabled}>
            <SettingsPage
              apiConfig={apiConfig}
              section={settingsSection}
              onSectionChange={setSettingsSection}
            />
          </fieldset>
        )}
      </div>
    </div>
  );
}
