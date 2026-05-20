# theming/

Portable React theming module. CSS-variable-based; no styled-component framework. Designed to be lifted out of this repo and dropped into any React+Vite (or React+anything) app with minimal changes.

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
<ThemeProvider persistence={...} extraPresets={...} bootstrap={...}>
  {/* your app */}
</ThemeProvider>

const { resolved, preferences, presets, setPreferences,
        exportPreferences, importPreferences, ready, saveError } = useTheme();
```

Tokens defined: see `types.ts` → `TokenName`. CSS defaults: `tokens.css`. Built-in presets: `presets.ts` (Light, Dark, Dim, High Contrast).

## Persistence contract

```ts
type Persistence = {
  load(): Promise<Preferences | null>;  // null on first launch
  save(prefs: Preferences): Promise<void>; // throw on failure
};
```

Both calls may be async (HTTP/IPC). Use the `bootstrap` prop to supply a synchronous cache (e.g. `localStorage`-cached prefs) for no-flash first paint.

## Token application

The provider applies tokens to `:root` via `style.setProperty("--token", value)` in an effect. No React re-render is triggered in styled components when the theme changes — only the variables on the root element change, and the browser repaints. This is what keeps theme switching instant on large apps.

Two `data-` attributes are also set for stylesheets that need to branch:
- `data-theme="light" | "dark"` (resolved mode)
- `data-theme-id="<preset id>"`

## Adding a token

1. Add the name to the `TokenName` union in `types.ts`.
2. Add its default to `tokens.css`.
3. Add its value to **every** preset in `presets.ts`.
4. Reference it via `var(--token)` in your app stylesheet.

## Adding a preset

Just append to `BUILT_IN_PRESETS` in `presets.ts`. New presets are additive — existing users on an old preset id stay on it.

## Adding a customizable override

The current overrides are `accent`, `background`, `foreground` and the two fonts. To add another:
1. Extend `Preferences.overrides` in `types.ts`.
2. Apply it in `ThemeProvider`'s `resolved` `useMemo`.
3. Add the input control to your appearance settings UI.

## Not in scope

- Color-contrast validation (callers can run their own).
- Web font loading (use the existing CSS `@font-face` mechanism in your app shell).
- Per-component theme overrides (you can do this in your stylesheet by reading `data-theme-id`).
- Animation/motion preferences (`prefers-reduced-motion` — add as a sibling module if needed).
