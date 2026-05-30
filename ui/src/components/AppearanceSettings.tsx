// AppearanceSettings — Codex-style: mode picker (Light/Dark/System) with
// a per-mode settings card below it that holds colors, fonts, sliders,
// and toggles. Share group (Export to file / Copy theme / Import) sits
// below.

import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_CONTRAST,
  DEFAULT_FONT_CODE_SIZE,
  DEFAULT_FONT_UI_SIZE,
  FONT_SUGGESTIONS,
  type Mode,
  type NamedTheme,
  type ReduceMotion,
} from "../theming/index.ts";
import { useAppearanceSettings } from "./useAppearanceSettings.ts";

export function AppearanceSettings(): JSX.Element {
  const {
    prefs,
    editingMode,
    editingConfig,
    themes,
    currentTheme,
    palette,
    hasOverrides,
    resolved,
    saveError,
    systemAccentAvailable,
    useSystemAccentEnabled,
    importError,
    copyStatus,
    fileInputRef,
    patchPrefs,
    patchConfig,
    resetOverrides,
    onExportFile,
    onCopyTheme,
    onImportFile,
    onPasteImport,
  } = useAppearanceSettings();

  const modeOptions: Array<{ id: Mode; label: string }> = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "System" },
  ];

  // When system accent is on (and available), the per-mode accent is
  // overridden app-wide — lock the Accent inputs so the override is legible
  // and "I edited accent but nothing changed" can't happen.
  const accentLockedBySystem = systemAccentAvailable && useSystemAccentEnabled;

  return (
    <>
      <div className="section">
        <h3>Theme</h3>
        <p className="meta">
          Use light, dark, or match your system. Each mode keeps its own colors and fonts.
          {resolved.fromSystem && (
            <>
              {" "}
              Following system: <strong>{resolved.resolvedMode}</strong>.
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
          {hasOverrides && (
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

        <ThemeDropdown
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
          disabled={accentLockedBySystem}
          note="Using your system accent — turn off to edit"
        />
        <ToggleRow
          label="Use system accent"
          description="Match your OS accent color"
          checked={useSystemAccentEnabled}
          onChange={(v) => patchPrefs({ useSystemAccent: v })}
          disabled={!systemAccentAvailable}
          hint={systemAccentAvailable ? undefined : "Available only in the desktop app"}
          dataTestId="theme-system-accent"
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

        <h4 className="appearance-subhead">Typography</h4>

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

        <h4 className="appearance-subhead">Surface</h4>

        <ContrastSlider
          value={editingConfig.contrast ?? DEFAULT_CONTRAST}
          onChange={(v) => patchConfig({ contrast: v })}
        />

        <ToggleRow
          label="Translucent sidebar"
          checked={editingConfig.translucentSidebar ?? false}
          onChange={(v) => patchConfig({ translucentSidebar: v })}
        />
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
        {saveError && (
          <div className="banner-error" data-testid="theme-save-error">
            Save failed: {saveError}
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
  disabled = false,
  note,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (next: string | undefined) => void;
  disabled?: boolean;
  note?: string;
}): JSX.Element {
  const effective = value || fallback;
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className={`appearance-row${disabled ? " appearance-row--control-disabled" : ""}`}>
      <label htmlFor={`color-${slug}-text`}>{label}</label>
      <div className="appearance-row-control">
        <input
          id={`color-${slug}-picker`}
          type="color"
          value={normalizeForColorInput(effective)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} color picker`}
          disabled={disabled}
        />
        <input
          id={`color-${slug}-text`}
          type="text"
          placeholder={fallback}
          value={value}
          onChange={(e) => onChange(e.target.value || undefined)}
          aria-label={`${label} color value`}
          disabled={disabled}
        />
        {!disabled && value !== "" && (
          <button
            type="button"
            className="reset"
            onClick={() => onChange(undefined)}
            title="Reset to theme value"
          >
            Reset
          </button>
        )}
        {disabled && note && <span className="appearance-hint">{note}</span>}
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
  disabled = false,
  hint,
  dataTestId,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Full-contrast explanatory text shown beside a disabled control. */
  hint?: string;
  dataTestId?: string;
}): JSX.Element {
  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className={`appearance-row${disabled ? " appearance-row--control-disabled" : ""}`}>
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
          disabled={disabled}
          data-testid={dataTestId}
        />
        {hint && <span className="appearance-hint">{hint}</span>}
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

// Two-band swatch — base (62%) + accent (38%) of THIS theme's palette, the
// two most recognizable tokens. Inline-styled because each row shows a
// different theme; the ring (CSS) derives from the live fg-default so a
// near-white light swatch stays visible on the popover. aria-hidden — the
// theme name is the accessible label, so color is never the only signal.
function ThemeSwatch({ tokens }: { tokens: Record<string, string> }): JSX.Element {
  const bg = tokens["color-bg-base"] ?? "#000";
  const accent = tokens["color-accent"] ?? "#888";
  return (
    <span
      className="theme-swatch"
      aria-hidden="true"
      style={{ background: `linear-gradient(90deg, ${bg} 0 62%, ${accent} 62% 100%)` }}
    />
  );
}

// Accessible Select-Only Combobox (WAI-ARIA): a button trigger + a listbox
// popover. Focus stays on the trigger until open, then moves to the <ul> so
// arrow keys land there; options never take DOM focus — aria-activedescendant
// tracks the active row. A native <select> can't render a per-row swatch in
// Chromium (US-6), which is why this is custom.
function ThemeDropdown({
  themes,
  activeId,
  onPick,
}: {
  themes: readonly NamedTheme[];
  activeId: string;
  onPick: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    themes.findIndex((t) => t.id === activeId),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number): string => `${baseId}-option-${i}`;
  const current = themes[selectedIndex];

  function openList(): void {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }
  function commit(i: number): void {
    onPick(themes[i].id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Move focus into the listbox on open so the keyboard map applies.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // Close on a pointer press outside the control.
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent): void {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep the active option scrolled into view as it moves.
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${baseId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, baseId]);

  function onTriggerKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    }
  }

  function onListKeyDown(e: React.KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(themes.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(themes.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        // Refocus the trigger before unmounting the list, then let the default
        // Tab advance from there. Closing the focused <ul> first would drop
        // focus to <body> instead of moving on. No preventDefault — same
        // refocus pattern as Esc/commit.
        triggerRef.current?.focus();
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div className="theme-dropdown" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="theme-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Theme"
        data-testid="theme-dropdown"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        <ThemeSwatch tokens={current.palette.tokens} />
        <span className="theme-dropdown-name">{current.name}</span>
        <span className="theme-dropdown-caret" aria-hidden="true" />
      </button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: spec-mandated W3C-APG Select-Only Combobox listbox; no native element renders per-row swatches (design-brief 5.1)
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox is the APG combobox popup role; intentional (design-brief 5.1)
        <ul
          ref={listRef}
          className="theme-dropdown-list"
          role="listbox"
          id={listId}
          aria-label="Theme"
          tabIndex={-1}
          aria-activedescendant={optionId(activeIndex)}
          onKeyDown={onListKeyDown}
        >
          {themes.map((t, i) => {
            const isSelected = t.id === activeId;
            const isActive = i === activeIndex;
            const cls = `theme-option${isActive ? " active" : ""}${isSelected ? " selected" : ""}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: option is the APG combobox row role; intentional (design-brief 5.1)
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: option is the APG combobox row role; intentional (design-brief 5.1)
              // biome-ignore lint/a11y/useFocusableInteractive: options are tracked via aria-activedescendant on the listbox, intentionally not individually focusable (design-brief 5.1)
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled at the listbox via aria-activedescendant; the option click is a pointer affordance
              <li
                key={t.id}
                id={optionId(i)}
                role="option"
                aria-selected={isSelected}
                data-testid={`theme-option-${t.id}`}
                className={cls}
                onClick={() => commit(i)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <ThemeSwatch tokens={t.palette.tokens} />
                <span className="theme-option-name">{t.name}</span>
                {isSelected && (
                  <span className="theme-option-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
