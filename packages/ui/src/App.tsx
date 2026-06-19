import { useState } from "react";
import type { ApiConfig } from "./api.ts";
import { KitDeployPage } from "./pages/KitDeployPage.tsx";
import { type SectionId, SettingsPage } from "./pages/SettingsPage.tsx";

type Page = "capabilities" | "settings";

export default function App({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [page, setPage] = useState<Page>("capabilities");
  const [settingsSection, setSettingsSection] = useState<SectionId>("appearance");

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
      <div className="body">
        {/* Kept mounted (not conditionally rendered) so the in-session deploy
            selection survives leaving and returning to the tab; display:contents
            keeps .kit-page as the direct flex child of .body when visible. */}
        <div style={{ display: page === "capabilities" ? "contents" : "none" }}>
          <KitDeployPage apiConfig={apiConfig} />
        </div>
        {page === "settings" && (
          <SettingsPage
            apiConfig={apiConfig}
            section={settingsSection}
            onSectionChange={setSettingsSection}
          />
        )}
      </div>
    </div>
  );
}
