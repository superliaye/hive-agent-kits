# theming/

Portable React theming module. CSS-variable-based; no styled-component framework. Designed to be lifted out of this repo and dropped into any React+Vite (or React+anything) app with minimal changes.

Modeled after Codex desktop's theming: `mode` picker + per-mode `ThemeConfig`. Each mode (light/dark) carries its own palette + typography overrides; the resolved mode is chosen from `system` via `matchMedia` when the user picked "system".

## What's portable

- Zero imports outside this directory or React.
- Persistence is **injected** — the module never touches `localStorage`, `fetch`, `electron-store`, or any specific storage.
- Tokens are flat string maps — no CSS-in-JS lock-in.

## What's not portable (lives outside this directory)

- The host app's `Persistence` adapter implementation (calls whatever backend you have).
- The host app's stylesheet (references `var(--token)` — you migrate hex literals to var-references).
- The host app's appearance settings UI (consumes `useTheme()`).

## Interface

```ts
<ThemeProvider persistence={...} bootstrap={...}>
  {/* your app */}
</ThemeProvider>

const { resolved, preferences, setPreferences,
        exportPreferences, importPreferences, ready, saveError } = useTheme();
```

Tokens defined: see `types.ts` → `TokenName`. CSS defaults: `tokens.css`. Base palettes: `presets.ts` (Light + Dark).

## Preferences shape

```ts
type Preferences = {
  mode: "light" | "dark" | "system";
  light: ThemeConfig;
  dark: ThemeConfig;
  reduceMotion: "system" | "on" | "off";
  pointerCursors: boolean;
};

type ThemeConfig = {
  accent?: string; background?: string; foreground?: string;
  fontUi?: string; fontCode?: string;
  fontUiSize?: number; fontCodeSize?: number;
  contrast?: number;          // 0..100, default 50
  translucentSidebar?: boolean;
};
```

## Persistence contract

```ts
type Persistence = {
  load(): Promise<Preferences | null>;  // null on first launch
  save(prefs: Preferences): Promise<void>; // throw on failure
};
```

Both calls may be async (HTTP/IPC). Use the `bootstrap` prop to supply a synchronous cache for no-flash first paint.

## Token application

The provider applies tokens to `:root` via `style.setProperty("--token", value)` in an effect. No React re-render is triggered in styled components when the theme changes — only the variables on the root element change, and the browser repaints.

Three `data-` attributes are also set for CSS branching:
- `data-theme="light" | "dark"` (resolved mode)
- `data-reduce-motion="on" | "off"` (resolved from prefs.reduceMotion + system)
- `data-pointer-cursors="on" | "off"`

`tokens.css` ships built-in CSS for `data-reduce-motion="on"` (kills animations/transitions globally) and `data-pointer-cursors="on"` (adds `cursor: pointer` to interactive elements).

## Wire format (share-with-friends)

- `exportPreferences(prefs)` returns pretty JSON, suited to file download.
- `exportPreferencesWire(prefs)` returns a single line prefixed with `codex-theme-v1:` — suited to clipboard copy / chat paste.
- `importPreferences(text)` accepts either form (strips the prefix if present).

The version prefix is `codex-theme-v1:` for parity with Codex desktop's clipboard wire format.

## Adding a token

1. Add the name to the `TokenName` union in `types.ts`.
2. Add its default to `tokens.css`.
3. Add its value to both palettes in `presets.ts`.
4. Reference it via `var(--token)` in your app stylesheet.

## Adding a customizable override

1. Extend `ThemeConfig` in `types.ts`.
2. Apply it inside `buildTokens()` in `ThemeProvider.tsx`.
3. Add the input control to your appearance settings UI.
4. Extend the parser in `serialize.ts` (else import drops the field silently).

## Not in scope

- Color-contrast validation (callers can run their own).
- Web font loading (use `@font-face` in your app shell).
- Per-component theme overrides (do this in your stylesheet by reading `data-theme`).
- Live theme preview pane (Codex has one; we don't — it'd require pulling in a syntax-highlight dependency).
