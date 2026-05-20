// AppearanceSettings — the host-app side of theming. Consumes useTheme()
// from the portable theming module. This file IS hive-aware (it sits in
// hive's components/), so it can render hive-flavored copy and use hive's
// existing styling conventions.

import { useRef, useState } from "react";
import { FONT_OPTIONS, type Preferences, useTheme } from "../theming/index.ts";

const SYSTEM_OPTION_ID = "system";

export function AppearanceSettings(): JSX.Element {
  const theme = useTheme();
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // System-follow is presented as a synthetic option alongside the real
  // presets. Selecting it stores `presetId: "system"`; the theming module
  // resolves to Light/Dark via matchMedia.
  const allOptions: Array<{ id: string; name: string; mode: "light" | "dark" | "auto" }> = [
    { id: SYSTEM_OPTION_ID, name: "System", mode: "auto" },
    ...theme.presets.map((p) => ({ id: p.id, name: p.name, mode: p.mode })),
  ];

  function changePreferences(patch: Partial<Preferences>): void {
    void theme.setPreferences({ ...theme.preferences, ...patch });
  }

  function setOverride(
    key: "accent" | "background" | "foreground",
    value: string | undefined,
  ): void {
    const next = { ...(theme.preferences.overrides ?? {}) };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    const cleaned = Object.keys(next).length === 0 ? undefined : next;
    void theme.setPreferences({ ...theme.preferences, overrides: cleaned });
  }

  function setFont(key: "ui" | "code", value: string | undefined): void {
    const next = { ...(theme.preferences.fonts ?? {}) };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    const cleaned = Object.keys(next).length === 0 ? undefined : next;
    void theme.setPreferences({ ...theme.preferences, fonts: cleaned });
  }

  function onExportClick(): void {
    const json = theme.exportPreferences();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hive-theme-${theme.preferences.presetId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    const text = await file.text();
    const result = await theme.importPreferences(text);
    if (!result.ok) setImportError(result.error);
    // Reset the input so the same file can be re-selected.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const overrides = theme.preferences.overrides ?? {};
  const fonts = theme.preferences.fonts ?? {};
  const currentUiFont = fonts.ui ?? "";
  const currentCodeFont = fonts.code ?? "";

  return (
    <>
      <div className="section">
        <h3>Theme</h3>
        <p className="meta">
          Active: <strong>{theme.resolved.preset.name}</strong>
          {theme.resolved.fromSystem && (
            <span className="meta"> (following system: {theme.resolved.preset.mode})</span>
          )}
        </p>
        <div className="appearance-presets" data-testid="theme-presets">
          {allOptions.map((opt) => {
            const active = theme.preferences.presetId === opt.id;
            const preset = theme.presets.find((p) => p.id === opt.id);
            const swatches = preset
              ? [
                  preset.tokens["color-bg-base"],
                  preset.tokens["color-bg-surface"],
                  preset.tokens["color-accent"],
                  preset.tokens["color-fg-default"],
                ]
              : null;
            return (
              <button
                type="button"
                key={opt.id}
                className={`appearance-preset${active ? " active" : ""}`}
                onClick={() => changePreferences({ presetId: opt.id })}
                data-testid={`theme-preset-${opt.id}`}
              >
                <div className="appearance-preset-name">{opt.name}</div>
                <div className="appearance-preset-mode">{opt.mode}</div>
                {swatches && (
                  <div className="appearance-preset-swatches">
                    {swatches.map((c, i) => (
                      <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: stable per preset
                        key={i}
                        className="appearance-swatch"
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="section">
        <h3>Colors</h3>
        <p className="meta">
          Layer custom colors on top of the chosen theme. Leave a field blank to fall back to the
          preset's value. Color inputs accept any CSS color string.
        </p>
        <ColorOverride
          label="Accent"
          value={overrides.accent ?? ""}
          fallback={theme.resolved.preset.tokens["color-accent"] ?? "#000000"}
          onChange={(v) => setOverride("accent", v)}
        />
        <ColorOverride
          label="Background"
          value={overrides.background ?? ""}
          fallback={theme.resolved.preset.tokens["color-bg-base"] ?? "#ffffff"}
          onChange={(v) => setOverride("background", v)}
        />
        <ColorOverride
          label="Foreground"
          value={overrides.foreground ?? ""}
          fallback={theme.resolved.preset.tokens["color-fg-default"] ?? "#000000"}
          onChange={(v) => setOverride("foreground", v)}
        />
      </div>

      <div className="section">
        <h3>Fonts</h3>
        <FontPicker
          label="UI"
          options={FONT_OPTIONS.ui as readonly { name: string; value: string }[]}
          value={currentUiFont}
          fallback={theme.resolved.preset.tokens["font-ui"] ?? ""}
          onChange={(v) => setFont("ui", v || undefined)}
        />
        <FontPicker
          label="Code"
          options={FONT_OPTIONS.code as readonly { name: string; value: string }[]}
          value={currentCodeFont}
          fallback={theme.resolved.preset.tokens["font-code"] ?? ""}
          onChange={(v) => setFont("code", v || undefined)}
        />
      </div>

      <div className="section">
        <h3>Share</h3>
        <p className="meta">Export your current theme as JSON, or import one a friend shared.</p>
        <div className="appearance-actions">
          <button
            type="button"
            className="button ghost"
            onClick={onExportClick}
            data-testid="theme-export"
          >
            Export…
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => fileInputRef.current?.click()}
            data-testid="theme-import"
          >
            Import…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              void onImportFile(e);
            }}
          />
        </div>
        {importError && (
          <div className="banner-error" data-testid="theme-import-error">
            Import failed: {importError}
          </div>
        )}
        {theme.saveError && (
          <div className="banner-error" data-testid="theme-save-error">
            Save failed: {theme.saveError}
          </div>
        )}
      </div>
    </>
  );
}

function ColorOverride({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (next: string | undefined) => void;
}): JSX.Element {
  // The native color input only accepts `#rrggbb` (no named colors, no
  // rgba). Use the text input for full CSS-string fidelity; the color
  // picker is a convenience.
  const effective = value || fallback;
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="appearance-override-row">
      <label htmlFor={`color-override-${slug}-text`}>{label}</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id={`color-override-${slug}-picker`}
          type="color"
          value={normalizeForColorInput(effective)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} color picker`}
        />
        <input
          id={`color-override-${slug}-text`}
          type="text"
          placeholder={fallback}
          value={value}
          onChange={(e) => onChange(e.target.value || undefined)}
          aria-label={`${label} color value`}
          style={{ flex: 1 }}
        />
      </div>
      <button
        type="button"
        className="reset"
        onClick={() => onChange(undefined)}
        disabled={value === ""}
        title={value === "" ? "No override" : "Reset to preset"}
      >
        Reset
      </button>
    </div>
  );
}

function FontPicker({
  label,
  options,
  value,
  fallback,
  onChange,
}: {
  label: string;
  options: readonly { name: string; value: string }[];
  value: string;
  fallback: string;
  onChange: (next: string) => void;
}): JSX.Element {
  // `value === ""` means "use preset default". Match the synthetic empty
  // option in the select.
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="appearance-font-row">
      <label htmlFor={`font-${slug}-select`}>{label}</label>
      <select id={`font-${slug}-select`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(preset default — {truncate(fallback, 40)})</option>
        {options.map((o) => (
          <option key={o.name} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// `<input type="color">` requires a 7-char `#rrggbb`. Anything else (named
// colors, `var(--…)`, rgba) gets normalized to black so the picker still
// renders; the text input retains full fidelity.
function normalizeForColorInput(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#000000";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
