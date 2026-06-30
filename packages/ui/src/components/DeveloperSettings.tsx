// DeveloperSettings — general-purpose developer settings surface. One compact
// SettingRow per setting (explanation folded behind the row's info icon), built
// to stay scannable as more dev settings land. Today a single row: "Deploy to
// real home directory". Off by default, a dev Deploy lands in a per-instance
// sandbox; on, it writes the real ~/.claude etc. Reads/writes the `developer`
// config slice through useDeveloperConfig (the shared data seam); KitDeployPage
// reads the same slice for its armed banner. The Deploy surface carries the loud
// armed warning, so the armed state here is a terse inline indicator.

import type { ApiConfig } from "../api.ts";
import { SettingRow } from "./SettingRow.tsx";
import { useDeveloperConfig } from "./useDeveloperConfig.ts";

export function DeveloperSettings({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const {
    armed: checked,
    loaded,
    setAllowRealHomeDeploy,
    saveError,
  } = useDeveloperConfig(apiConfig);

  return (
    <div className="section">
      <SettingRow
        label="Deploy to real home directory"
        controlDisabled={!loaded}
        explanation={
          <>
            <strong className="setting-info-lead">
              On, every Deploy overwrites your real <code>~/.claude</code>, <code>~/.codex</code>,
              and <code>~/.agents</code> — no sandbox safety net.
            </strong>{" "}
            Off (the default), a Deploy in this dev instance lands in a per-instance sandbox and
            never touches your real CLI homes. Affects this dev instance only; packaged builds
            always deploy to the real home.
          </>
        }
      >
        {({ controlId, describedById }) => (
          <>
            <input
              id={controlId}
              type="checkbox"
              checked={checked}
              onChange={(e) => setAllowRealHomeDeploy(e.target.checked)}
              data-testid="developer-allow-real-home-deploy"
              aria-describedby={describedById}
              disabled={!loaded}
            />
            {/* Persistent live region: always in the DOM, text toggles on arm,
                so the destructive state is announced reliably (an inserted alert
                node is announced inconsistently across screen readers). */}
            <span
              className={checked ? "setting-armed" : "sr-only"}
              data-testid={checked ? "developer-real-home-armed" : undefined}
              role="status"
              aria-live="assertive"
            >
              {checked ? "Armed — overwrites real home, no sandbox" : ""}
            </span>
          </>
        )}
      </SettingRow>
      {saveError && (
        <div className="banner-error" data-testid="developer-save-error">
          Save failed: {saveError.message}
        </div>
      )}
    </div>
  );
}
