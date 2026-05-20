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
 * The listener is called only on transitions (light → dark or dark → light),
 * not on every theme-related event. Safe to call repeatedly; each call
 * returns its own subscription.
 */
export function watchSystemMode(listener: (mode: "light" | "dark") => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent): void => {
    listener(e.matches ? "dark" : "light");
  };
  // Both modern (`addEventListener`) and Safari ≤14 (`addListener`) paths.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy Safari MediaQueryList shape
  const legacy = mql as unknown as {
    addListener: (h: (e: MediaQueryListEvent) => void) => void;
    removeListener: (h: (e: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(handler);
  return () => {
    legacy.removeListener(handler);
  };
}
