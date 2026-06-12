import type { ApiConfig } from "../api.ts";
import { AppearanceSettings } from "../components/AppearanceSettings.tsx";
import { BackendsSettings } from "../components/BackendsSettings.tsx";
import { SecretsSettings } from "../components/SecretsSettings.tsx";

export type SectionId = "appearance" | "secrets" | "backends" | "other";

type Section = {
  id: SectionId;
  label: string;
  description: string;
};

const SECTIONS: readonly Section[] = [
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme mode, per-mode palette and typography, accessibility toggles.",
  },
  {
    id: "secrets",
    label: "Secrets",
    description:
      "API keys and OAuth credentials for model providers. Stored locally in ~/.hive/secrets.json with file mode 0600.",
  },
  {
    id: "backends",
    label: "Backends",
    description:
      "Detected CLI agent backends (Claude Code, Codex): health, version, and delegated updates. Hive detects and delegates — it does not install.",
  },
  {
    id: "other",
    label: "Other",
    description:
      "Audit retention, daemon port, and log level. Configurable via ~/.hive/config.yaml in v1; UI editor lands in v1.1 per ADR-0006.",
  },
];

export function SettingsPage({
  apiConfig,
  section,
  onSectionChange,
}: {
  apiConfig: ApiConfig;
  section: SectionId;
  onSectionChange: (section: SectionId) => void;
}): JSX.Element {
  const active = section;
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
                onClick={() => onSectionChange(s.id)}
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
        <div className="settings-detail-inner">
          <header className="settings-detail-header">
            <h1>{activeSection.label}</h1>
            <p className="meta">{activeSection.description}</p>
          </header>
          {active === "appearance" && <AppearanceSettings />}
          {active === "secrets" && <SecretsSettings apiConfig={apiConfig} />}
          {active === "backends" && <BackendsSettings apiConfig={apiConfig} />}
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
    </div>
  );
}
