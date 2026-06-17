// System preference detection — `prefers-color-scheme` via matchMedia.
// Pure browser API; works under Electron Chromium and any modern browser.

/**
 * Read the current OS preference. Defaults to "light" when the API is
 * unavailable (SSR, old browsers).
 */
export function getSystemMode(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Subscribe to OS preference changes. Returns a disposer.
 *
 * The listener fires only on transitions (light → dark or dark → light),
 * not on every theme-related event. Safe to call repeatedly; each call
 * returns its own subscription.
 *
 * Targets `MediaQueryList.addEventListener` — Safari 14+ (Sept 2020),
 * every other modern browser, and all Electron Chromium versions. The
 * legacy `addListener` fallback was dropped along with the
 * `as unknown as` cast that supported it (AGENTS.md bans the cast).
 */
export function watchSystemMode(listener: (mode: "light" | "dark") => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent): void => {
    listener(e.matches ? "dark" : "light");
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
