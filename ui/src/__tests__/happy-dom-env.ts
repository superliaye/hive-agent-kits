// Shared happy-dom + React-DOM test harness. GlobalRegistrator installs a real
// DOM onto globalThis (using lib.dom types, so no casts), and we flag the React
// act environment to suppress the "not configured to support act(...)" warning.
// Call setupDom() in beforeAll and teardownDom() in afterAll.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function setupDom(): void {
  GlobalRegistrator.register({ url: "http://localhost" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export async function teardownDom(): Promise<void> {
  await GlobalRegistrator.unregister();
}

// Mount a fresh detached host into document.body for one render.
export function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

export function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}
