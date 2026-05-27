// AppearanceSettings — Codex-style: mode picker (Light/Dark/System) with
// a per-mode settings card below it that holds colors, fonts, sliders,
// and toggles. Share group (Export to file / Copy theme / Import) sits
// below.

import { useRef, useState } from "react";
import {
  DEFAULT_CONTRAST,
  DEFAULT_FONT_CODE_SIZE,
  DEFAULT_FONT_UI_SIZE,
  FONT_SUGGESTIONS,
  findNamedTheme,
  type Mode,
  type NamedTheme,
  namedThemesFor,
  type Preferences,
  type ReduceMotion,
  type ThemeConfig,
  exportPreferencesWire,
  useTheme,
} from "../theming/index.ts";

// Keys on ThemeConfig that count as "overrides" the user can clear in
// bulk. themeId is the named-palette selection — NOT an override.
const OVERRIDE_KEYS: ReadonlyArray<Exclude<keyof ThemeConfig, "themeId">> = [
  "accent",
  "background",
  "foreground",
  "fontUi",
  "fontCode",
  "fontUiSize",
  "fontCodeSize",
  "contrast",
  "translucentSidebar",
];

function hasOverrides(config: ThemeConfig): boolean {
  return OVERRIDE_KEYS.some((k) => config[k] !== undefined);
}

export function AppearanceSettings(): JSX.Element {
  const theme = useTheme();
  const [importError, setImportError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const prefs = theme.preferences;
  // Card always edits the mode that's currently *applied* (resolved from
  // system-follow when needed). Matches Codex: one card, one mode.
  const editingMode = theme.resolved.resolvedMode;
  const editingConfig: ThemeConfig = editingMode === "dark" ? prefs.dark : prefs.light;
  const themes = namedThemesFor(editingMode);
  const currentTheme = findNamedTheme(editingMode, editingConfig.themeId);
  const palette = currentTheme.palette;

  function patchPrefs(patch: Partial<Preferences>): void {
    void theme.setPreferences({ ...prefs, ...patch });
  }

  function patchConfig(patch: Partial<ThemeConfig>): void {
    const next = { ...editingConfig, ...patch };
    for (const k of Object.keys(next) as (keyof ThemeConfig)[]) {
      if (next[k] === undefined || next[k] === "") delete next[k];
    }
    patchPrefs(editingMode === "dark" ? { dark: next } : { light: next });
  }

  function resetOverrides(): void {
    // Keep themeId (the user's named-palette choice), drop everything else.
    const next: ThemeConfig = editingConfig.themeId
      ? { themeId: editingConfig.themeId }
      : {};
    patchPrefs(editingMode === "dark" ? { dark: next } : { light: next });
  }

  function onExportFile(): void {
    const json = theme.exportPreferences();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hive-theme-${prefs.mode}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function onCopyTheme(): Promise<void> {
    const wire = exportPreferencesWire(prefs);
    try {
      await navigator.clipboard.writeText(wire);
      setCopyStatus("Copied!");
    } catch {
      setCopyStatus("Copy failed (clipboard blocked)");
    }
    window.setTimeout(() => setCopyStatus(null), 2000);
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    const text = await file.text();
    const result = await theme.importPreferences(text);
    if (!result.ok) setImportError(result.error);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onPasteImport(): Promise<void> {
    setImportError(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setImportError("Clipboard read blocked — use Import File instead");
      return;
    }
    const result = await theme.importPreferences(text);
    if (!result.ok) setImportError(result.error);
  }

  const modeOptions: Array<{ id: Mode; label: string }> = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "System" },
  ];

  return (
    <>
      <div className="section">
        <h3>Theme</h3>
        <p className="meta">
          Use light, dark, or match your system. Each mode keeps its own colors and fonts.
          {theme.resolved.fromSystem && (
            <>
              {" "}
              Following system: <strong>{theme.resolved.resolvedMode}</strong>.
            </>
          )}
        </p>
        <div className="appearance-mode-row" data-testid="theme-mode-row">
          {modeOptions.map((opt) => (
            <button
              type="button"
              key={opt.id}
              className={`appearance-mode-btn${prefs.mode === opt.id ? " active" : ""}`}
              onClick={() => patchPrefs({ mode: opt.id })}
              data-testid={`theme-mode-${opt.id}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="section settings-card">
        <div className="appearance-card-header">
          <h3 className="settings-card-title">
            {editingMode === "dark" ? "Dark" : "Light"} theme
          </h3>
          {hasOverrides(editingConfig) && (
            <div className="appearance-card-modified-cluster">
              <span
                className="settings-card-modified-dot"
                title="This mode has unsaved overrides on top of the named theme"
                aria-label="Modified"
              />
              <button
                type="button"
                className="appearance-reset-link"
                onClick={() => resetOverrides()}
                data-testid="theme-reset-overrides"
                title="Clear all per-mode customizations and use the named theme as-is"
              >
                Reset overrides
              </button>
            </div>
          )}
        </div>

        <ThemeGallery
          themes={themes}
          activeId={currentTheme.id}
          onPick={(id) => patchConfig({ themeId: id })}
        />

        <h4 className="appearance-subhead">Custom colors</h4>

        <ColorOverride
          label="Accent"
          value={editingConfig.accent ?? ""}
          fallback={palette.tokens["color-accent"] ?? "#000000"}
          onChange={(v) => patchConfig({ accent: v })}
        />
        <ColorOverride
          label="Background"
          value={editingConfig.background ?? ""}
          fallback={palette.tokens["color-bg-base"] ?? "#ffffff"}
          onChange={(v) => patchConfig({ background: v })}
        />
        <ColorOverride
          label="Foreground"
          value={editingConfig.foreground ?? ""}
          fallback={palette.tokens["color-fg-default"] ?? "#000000"}
          onChange={(v) => patchConfig({ foreground: v })}
        />

        <details className="appearance-details" data-testid="typography-disclosure">
          <summary>Typography &amp; density</summary>

          <FontInput
            label="UI font"
            value={editingConfig.fontUi ?? ""}
            fallback={palette.tokens["font-ui"] ?? ""}
            suggestions={FONT_SUGGESTIONS.ui}
            onChange={(v) => patchConfig({ fontUi: v })}
          />
          <FontInput
            label="Code font"
            value={editingConfig.fontCode ?? ""}
            fallback={palette.tokens["font-code"] ?? ""}
            suggestions={FONT_SUGGESTIONS.code}
            onChange={(v) => patchConfig({ fontCode: v })}
          />

          <SizeInput
            label="UI font size"
            value={editingConfig.fontUiSize ?? DEFAULT_FONT_UI_SIZE}
            onChange={(v) => patchConfig({ fontUiSize: v })}
          />
          <SizeInput
            label="Code font size"
            value={editingConfig.fontCodeSize ?? DEFAULT_FONT_CODE_SIZE}
            onChange={(v) => patchConfig({ fontCodeSize: v })}
          />

          <ContrastSlider
            value={editingConfig.contrast ?? DEFAULT_CONTRAST}
            onChange={(v) => patchConfig({ contrast: v })}
          />

          <ToggleRow
            label="Translucent sidebar"
            checked={editingConfig.translucentSidebar ?? false}
            onChange={(v) => patchConfig({ translucentSidebar: v })}
          />
        </details>
      </div>

      <div className="section">
        <h3>Accessibility</h3>
        <TriStateRow
          label="Reduce motion"
          description="Reduce animations or match your system"
          value={prefs.reduceMotion}
          onChange={(v) => patchPrefs({ reduceMotion: v })}
        />
        <ToggleRow
          label="Use pointer cursors"
          description="Change the cursor to a pointer when hovering over interactive elements"
          checked={prefs.pointerCursors}
          onChange={(v) => patchPrefs({ pointerCursors: v })}
        />
      </div>

      <div className="section">
        <h3>Share</h3>
        <p className="meta">
          Copy a one-line wire form to share via chat, or export/import a JSON file.
        </p>
        <div className="appearance-actions">
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              void onCopyTheme();
            }}
            data-testid="theme-copy"
          >
            {copyStatus ?? "Copy theme"}
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              void onPasteImport();
            }}
            data-testid="theme-paste"
          >
            Paste import
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={onExportFile}
            data-testid="theme-export"
          >
            Export file…
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => fileInputRef.current?.click()}
            data-testid="theme-import"
          >
            Import file…
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
  const effective = value || fallback;
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="appearance-row">
      <label htmlFor={`color-${slug}-text`}>{label}</label>
      <div className="appearance-row-control">
        <input
          id={`color-${slug}-picker`}
          type="color"
          value={normalizeForColorInput(effective)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} color picker`}
        />
        <input
          id={`color-${slug}-text`}
          type="text"
          placeholder={fallback}
          value={value}
          onChange={(e) => onChange(e.target.value || undefined)}
          aria-label={`${label} color value`}
        />
        {value !== "" && (
          <button
            type="button"
            className="reset"
            onClick={() => onChange(undefined)}
            title="Reset to theme value"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function FontInput({
  label,
  value,
  fallback,
  suggestions,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  suggestions: readonly { name: string; value: string }[];
  onChange: (next: string | undefined) => void;
}): JSX.Element {
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  const listId = `font-${slug}-list`;
  return (
    <div className="appearance-row">
      <label htmlFor={`font-${slug}-input`}>{label}</label>
      <div className="appearance-row-control">
        <input
          id={`font-${slug}-input`}
          type="text"
          list={listId}
          placeholder={truncate(fallback, 60)}
          value={value}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s.name} value={s.value} label={s.name} />
          ))}
        </datalist>
        {value !== "" && (
          <button
            type="button"
            className="reset"
            onClick={() => onChange(undefined)}
            title="Reset to theme value"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function SizeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number | undefined) => void;
}): JSX.Element {
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="appearance-row">
      <label htmlFor={`size-${slug}-input`}>{label}</label>
      <div className="appearance-row-control appearance-row-control--narrow">
        <input
          id={`size-${slug}-input`}
          type="number"
          min={8}
          max={48}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange(n);
          }}
        />
        <span className="meta">px</span>
      </div>
    </div>
  );
}

function ContrastSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}): JSX.Element {
  const adjusted = value !== DEFAULT_CONTRAST;
  return (
    <div className="appearance-row">
      <label htmlFor="slider-contrast">Contrast</label>
      <div className="appearance-row-control appearance-slider-control">
        <span className="appearance-slider-axis-label">Softer</span>
        <input
          id="slider-contrast"
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          list="contrast-ticks"
          aria-valuetext={adjusted ? `${value}, adjusted from default 50` : "default 50"}
        />
        <datalist id="contrast-ticks">
          <option value={DEFAULT_CONTRAST} label="default" />
        </datalist>
        <span className="appearance-slider-axis-label">Sharper</span>
        <span
          className={`appearance-slider-value${adjusted ? " adjusted" : ""}`}
          aria-hidden="true"
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="appearance-row">
      <div className="appearance-row-label">
        <label htmlFor={`toggle-${slug}`}>{label}</label>
        {description && <span className="meta">{description}</span>}
      </div>
      <div className="appearance-row-control">
        <input
          id={`toggle-${slug}`}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
    </div>
  );
}

function TriStateRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: ReduceMotion;
  onChange: (next: ReduceMotion) => void;
}): JSX.Element {
  const opts: ReduceMotion[] = ["system", "on", "off"];
  return (
    <div className="appearance-row">
      <div className="appearance-row-label">
        <span>{label}</span>
        {description && <span className="meta">{description}</span>}
      </div>
      <div className="appearance-row-control appearance-tri-state">
        {opts.map((opt) => (
          <button
            type="button"
            key={opt}
            className={`appearance-sub-btn${value === opt ? " active" : ""}`}
            onClick={() => onChange(opt)}
            aria-pressed={value === opt}
          >
            {opt.charAt(0).toUpperCase() + opt.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemeGallery({
  themes,
  activeId,
  onPick,
}: {
  themes: readonly NamedTheme[];
  activeId: string;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <div className="theme-gallery" data-testid="theme-gallery">
      {themes.map((t) => {
        const isActive = t.id === activeId;
        return (
          <button
            type="button"
            key={t.id}
            className={`theme-gallery-item${isActive ? " active" : ""}`}
            onClick={() => onPick(t.id)}
            data-testid={`theme-gallery-${t.id}`}
            aria-pressed={isActive}
            aria-label={`Use ${t.name}`}
          >
            {isActive && (
              <span className="theme-gallery-check" aria-hidden="true">
                ✓
              </span>
            )}
            <ThemePreview tokens={t.palette.tokens} />
            <div className="theme-gallery-name">{t.name}</div>
          </button>
        );
      })}
    </div>
  );
}

function ThemePreview({ tokens }: { tokens: Record<string, string> }): JSX.Element {
  // Structured mock: title-bar + two text lines (fg + muted) + status
  // dots (accent / success / warning / danger). Uses all 7 semantic
  // tokens per theme so palettes are visually distinguishable.
  const bgBase = tokens["color-bg-base"] ?? "#000";
  const bgSurface = tokens["color-bg-surface"] ?? "#111";
  const fg = tokens["color-fg-default"] ?? "#fff";
  const fgMuted = tokens["color-fg-muted"] ?? "#888";
  const accent = tokens["color-accent"] ?? "#4a8eff";
  const success = tokens["color-success"] ?? "#56d364";
  const warning = tokens["color-warning"] ?? "#ffb454";
  const danger = tokens["color-danger"] ?? "#ff6b6b";
  return (
    <div className="theme-preview" style={{ background: bgBase }} aria-hidden="true">
      <div className="theme-preview-titlebar" style={{ background: bgSurface }} />
      <div
        className="theme-preview-line theme-preview-line--primary"
        style={{ background: fg }}
      />
      <div
        className="theme-preview-line theme-preview-line--secondary"
        style={{ background: fgMuted }}
      />
      <div className="theme-preview-dots">
        <span className="theme-preview-dot" style={{ background: accent }} />
        <span className="theme-preview-dot" style={{ background: success }} />
        <span className="theme-preview-dot" style={{ background: warning }} />
        <span className="theme-preview-dot" style={{ background: danger }} />
      </div>
    </div>
  );
}

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
