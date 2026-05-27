import { useState } from "react";
import type { ApiConfig } from "../api.ts";
import { AppearanceSettings } from "../components/AppearanceSettings.tsx";
import { SecretsSettings } from "../components/SecretsSettings.tsx";

type SectionId = "appearance" | "secrets" | "other";

type Section = {
  id: SectionId;
  label: string;
  description: string;
};

const SECTIONS: readonly Section[] = [
  {
    id: "appearance",
    label: "Appearance",
    description:
      "Theme mode, per-mode palette + typography, accessibility toggles. Preferences live in ~/.hive/config.yaml under the appearance key.",
  },
  {
    id: "secrets",
    label: "Secrets",
    description:
      "API keys and OAuth credentials for model providers. Stored locally in ~/.hive/secrets.json with file mode 0600.",
  },
  {
    id: "other",
    label: "Other",
    description:
      "Audit retention, daemon port, and log level. Configurable via ~/.hive/config.yaml in v1; UI editor lands in v1.1 per ADR-0006.",
  },
];

export function SettingsPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [active, setActive] = useState<SectionId>("appearance");
  const activeSection = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`settings-nav-item${active === s.id ? " active" : ""}`}
                onClick={() => setActive(s.id)}
                data-testid={`settings-nav-${s.id}`}
                aria-current={active === s.id ? "page" : undefined}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-detail">
        <header className="settings-detail-header">
          <h1>{activeSection.label}</h1>
          <p className="meta">{activeSection.description}</p>
        </header>
        {active === "appearance" && <AppearanceSettings />}
        {active === "secrets" && <SecretsSettings apiConfig={apiConfig} />}
        {active === "other" && (
          <div className="section">
            <p className="empty">
              Configurable via <code>~/.hive/config.yaml</code> in v1; UI editor lands in v1.1 per
              ADR-0006.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
