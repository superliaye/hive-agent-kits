import { useState } from "react";
import type { ApiConfig } from "./api.ts";
import { AgentsPage } from "./pages/AgentsPage.tsx";
import { CapabilitiesPage } from "./pages/CapabilitiesPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";

type Page = "agents" | "capabilities" | "settings";

export default function App({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [page, setPage] = useState<Page>("agents");
  return (
    <div className="app">
      <div className="tabs">
        <button
          className={`tab ${page === "agents" ? "active" : ""}`}
          onClick={() => setPage("agents")}
          data-testid="tab-agents"
        >
          Agents
        </button>
        <button
          className={`tab ${page === "capabilities" ? "active" : ""}`}
          onClick={() => setPage("capabilities")}
          data-testid="tab-capabilities"
        >
          Capabilities
        </button>
        <button
          className={`tab ${page === "settings" ? "active" : ""}`}
          onClick={() => setPage("settings")}
          data-testid="tab-settings"
        >
          Settings
        </button>
      </div>
      <div className="body">
        {page === "agents" && <AgentsPage apiConfig={apiConfig} />}
        {page === "capabilities" && <CapabilitiesPage apiConfig={apiConfig} />}
        {page === "settings" && <SettingsPage apiConfig={apiConfig} />}
      </div>
    </div>
  );
}
