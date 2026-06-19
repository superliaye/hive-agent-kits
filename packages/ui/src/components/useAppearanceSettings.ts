// Orchestration hook for the Appearance settings panel.
//
// The component itself is ~650 lines of JSX. Extracting the state
// machine (which mode is being edited, has this mode been customized,
// what does Reset clear, how do export/import/clipboard flows behave)
// into a hook means:
//
//   - The hook becomes the testable surface (no DOM mount required).
//   - The component file becomes pure JSX threaded against a single
//     hook return value — easier to scan, easier to restyle.
//   - Sub-components stay where they are (already presentation-only).
//
// One consumer today (AppearanceSettings.tsx). The deepening payoff is
// separation of concerns, not reuse.

import { useCallback, useRef, useState } from "react";
import {
  exportPreferencesWire,
  findNamedTheme,
  type NamedTheme,
  namedThemesFor,
  type Preferences,
  type ResolvedMode,
  type ResolvedTheme,
  type ThemeConfig,
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

export function hasOverrides(config: ThemeConfig): boolean {
  return OVERRIDE_KEYS.some((k) => config[k] !== undefined);
}

// The accent value the Accent control should display. When system accent is
// locked on, the per-mode `accent` override is dormant — the app renders the
// OS accent (resolveEffectiveConfig writes it into the effective config). Show
// that applied value so the swatch matches the rest of the chrome. Otherwise
// the control owns its per-mode override (or the empty string → palette
// fallback in the component).
export function displayedAccent(args: {
  locked: boolean;
  overrideAccent: string | undefined;
  effectiveAccent: string | undefined;
}): string {
  if (args.locked) return args.effectiveAccent ?? "";
  return args.overrideAccent ?? "";
}

// State captured by a Reset so an Undo can restore it exactly. Bound to the
// mode it was taken in — a mode switch between reset and undo invalidates it.
export type ResetSnapshot = {
  mode: ResolvedMode;
  config: ThemeConfig;
};

export type UseAppearanceSettingsReturn = {
  // Read state
  prefs: Preferences;
  editingMode: ResolvedMode;
  editingConfig: ThemeConfig;
  themes: readonly NamedTheme[];
  currentTheme: NamedTheme;
  palette: NamedTheme["palette"];
  hasOverrides: boolean;
  resolved: ResolvedTheme;
  saveError: string | null;
  /** True when the host exposes an OS accent (Electron). Gates the toggle. */
  systemAccentAvailable: boolean;
  /** Mirrors prefs.useSystemAccent — the app-wide system-accent opt-in. */
  useSystemAccentEnabled: boolean;
  /** True when the OS accent is overriding the per-mode accent app-wide. */
  accentLockedBySystem: boolean;
  /** Accent value the Accent control should show (applied OS accent when locked). */
  accentDisplayValue: string;
  // Transient UI state (import errors, "Copied!" feedback)
  importError: string | null;
  copyStatus: string | null;
  /** Set while the post-reset Undo affordance is live; null when dismissed. */
  canUndoReset: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  // Mutators
  patchPrefs: (patch: Partial<Preferences>) => void;
  patchConfig: (patch: Partial<ThemeConfig>) => void;
  resetOverrides: () => void;
  undoReset: () => void;
  // Share actions
  onExportFile: () => void;
  onCopyTheme: () => Promise<void>;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onPasteImport: () => Promise<void>;
};

export function useAppearanceSettings(): UseAppearanceSettingsReturn {
  const theme = useTheme();
  const [importError, setImportError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [resetSnapshot, setResetSnapshot] = useState<ResetSnapshot | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const prefs = theme.preferences;
  // Card always edits the mode that's currently *applied* (resolved from
  // system-follow when needed). Matches Codex: one card, one mode.
  const editingMode = theme.resolved.resolvedMode;
  const editingConfig: ThemeConfig = editingMode === "dark" ? prefs.dark : prefs.light;
  const themes = namedThemesFor(editingMode);
  const currentTheme = findNamedTheme(editingMode, editingConfig.themeId);
  const palette = currentTheme.palette;
  // OS accent is host-injected; the toggle is only meaningful when the
  // Electron bridge is present (web/dev mode disables it).
  const systemAccentAvailable =
    typeof window !== "undefined" && typeof window.__hive?.getSystemAccent === "function";
  // When system accent is on (and available), the OS accent overrides the
  // per-mode accent app-wide — the Accent control locks and shows the applied
  // value, not the dormant override.
  const accentLockedBySystem = systemAccentAvailable && prefs.useSystemAccent;

  const patchPrefs = useCallback(
    (patch: Partial<Preferences>): void => {
      void theme.setPreferences({ ...prefs, ...patch });
    },
    [prefs, theme.setPreferences],
  );

  const patchConfig = useCallback(
    (patch: Partial<ThemeConfig>): void => {
      const next = { ...editingConfig, ...patch };
      for (const k of Object.keys(next) as (keyof ThemeConfig)[]) {
        if (next[k] === undefined || next[k] === "") delete next[k];
      }
      patchPrefs(editingMode === "dark" ? { dark: next } : { light: next });
    },
    [editingConfig, editingMode, patchPrefs],
  );

  // ~6s — longer than the 2s copy toast so the user can actually catch the
  // Undo affordance before it auto-dismisses.
  const UNDO_WINDOW_MS = 6000;

  const resetOverrides = useCallback((): void => {
    // Snapshot the pre-reset config (and its mode) so Undo can restore it
    // exactly; a second reset before the timer fires re-captures (latest wins).
    setResetSnapshot({ mode: editingMode, config: editingConfig });
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => {
      setResetSnapshot(null);
      undoTimerRef.current = null;
    }, UNDO_WINDOW_MS);

    // Keep themeId (the user's named-palette choice), drop everything else.
    const next: ThemeConfig = editingConfig.themeId ? { themeId: editingConfig.themeId } : {};
    patchPrefs(editingMode === "dark" ? { dark: next } : { light: next });
  }, [editingConfig, editingMode, patchPrefs]);

  const undoReset = useCallback((): void => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setResetSnapshot((snap) => {
      if (snap) patchPrefs(snap.mode === "dark" ? { dark: snap.config } : { light: snap.config });
      return null;
    });
  }, [patchPrefs]);

  const onExportFile = useCallback((): void => {
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
  }, [prefs.mode, theme.exportPreferences]);

  const onCopyTheme = useCallback(async (): Promise<void> => {
    const wire = exportPreferencesWire(prefs);
    try {
      await navigator.clipboard.writeText(wire);
      setCopyStatus("Copied!");
    } catch {
      setCopyStatus("Copy failed (clipboard blocked)");
    }
    window.setTimeout(() => setCopyStatus(null), 2000);
  }, [prefs]);

  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      if (!file) return;
      setImportError(null);
      const text = await file.text();
      const result = await theme.importPreferences(text);
      if (!result.ok) setImportError(result.error);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [theme.importPreferences],
  );

  const onPasteImport = useCallback(async (): Promise<void> => {
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
  }, [theme.importPreferences]);

  return {
    prefs,
    editingMode,
    editingConfig,
    themes,
    currentTheme,
    palette,
    hasOverrides: hasOverrides(editingConfig),
    resolved: theme.resolved,
    saveError: theme.saveError,
    systemAccentAvailable,
    useSystemAccentEnabled: prefs.useSystemAccent,
    accentLockedBySystem,
    accentDisplayValue: displayedAccent({
      locked: accentLockedBySystem,
      overrideAccent: editingConfig.accent,
      effectiveAccent: theme.resolved.config.accent,
    }),
    importError,
    copyStatus,
    canUndoReset: resetSnapshot !== null,
    fileInputRef,
    patchPrefs,
    patchConfig,
    resetOverrides,
    undoReset,
    onExportFile,
    onCopyTheme,
    onImportFile,
    onPasteImport,
  };
}
