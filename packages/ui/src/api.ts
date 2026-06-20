// Daemon API client. Reads baseUrl + token from:
//   1. window.__hive (provided by Electron preload)
//   2. URL query string ?baseUrl=...&token=... (dev mode in a browser tab)
//
// Wire types are sourced from @hive/contract (the single source of truth). The
// kit names use the contract's canonical unprefixed form.

import type {
  BackendReadiness,
  BackendStatus,
  Catalog,
  DeployDiff,
  DeployResult,
  KitState,
  Selection,
  SyncStatus,
  VerifyReport,
} from "@hive/contract";
import type { Preferences } from "@hive/theming";

export type {
  BackendAuthState,
  BackendReadiness,
  BackendStatus,
  CapabilityEntry,
  CapabilityKind,
  Catalog,
  CatalogProblem,
  DeployDiff,
  DeployResult,
  DeployTarget,
  DiffEntry,
  KindResult,
  KitState,
  Ledger,
  PresetSummary,
  Selection,
  StoredSecretMeta,
  SyncStatus,
  SyncStatusState,
  VerifyEntry,
  VerifyReport,
  VerifyStatus,
  VerifyTargetStatus,
} from "@hive/contract";

declare global {
  interface Window {
    __hive?: {
      baseUrl: string;
      token: string;
      /** "win32" | "darwin" | "linux" — undefined outside Electron. */
      platform?: string;
      // Open an http(s) URL in the user's default external browser. Only
      // present in Electron (preload bridge). Use the `openUrl()` helper
      // below instead of touching this directly — it falls back to
      // `window.open()` in browser-tab mode (Vite dev).
      openExternal?: (url: string) => Promise<void>;
      /** Update Electron title-bar overlay + nativeTheme.themeSource. */
      setChromeTheme?: (payload: {
        mode: "light" | "dark";
        bg: string;
        fg: string;
      }) => Promise<void>;
      /** Read the OS accent color (`#rrggbb`), or null when unavailable.
       * Only present in Electron (preload bridge); absent in browser-tab mode. */
      getSystemAccent?: () => Promise<string | null>;
      /** Signal the main process that a Kit deploy is/isn't in flight, so a quit
       * mid-deploy prompts a confirm. Only present in Electron (preload bridge). */
      setDeployInFlight?: (inFlight: boolean) => Promise<void>;
    };
  }
}

/**
 * Open an http(s) URL in the user's default external browser.
 *
 * In Electron: calls the preload bridge → main process's
 * `shell.openExternal(url)`, so the user's real browser handles the page rather
 * than the in-app webview.
 *
 * In a plain browser tab (Vite dev): falls back to `window.open(url, "_blank")`.
 */
export async function openUrl(url: string): Promise<void> {
  const bridge = typeof window !== "undefined" ? window.__hive?.openExternal : undefined;
  if (bridge) {
    await bridge(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export type ApiConfig = { baseUrl: string; token: string };

export function resolveApiConfig(): ApiConfig {
  if (typeof window !== "undefined" && window.__hive) {
    return window.__hive;
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const baseUrl = params.get("baseUrl") ?? "http://127.0.0.1:3117";
    const token = params.get("token") ?? "";
    return { baseUrl, token };
  }
  return { baseUrl: "http://127.0.0.1:3117", token: "" };
}

async function call<T>(cfg: ApiConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}`);
  }
  return (await res.json()) as T;
}

async function callVoid(cfg: ApiConfig, path: string, init: RequestInit = {}): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText} on ${path}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Consume an SSE response body line-by-line via the Fetch streams API.
 *
 * `onEvent(name, data)` fires once per SSE message. `data` is JSON-parsed
 * if it looks like JSON, otherwise passed as a string. Returns when the
 * stream ends naturally or when `signal` aborts (rejects with AbortError
 * in that case).
 */
export async function consumeSSE(
  cfg: ApiConfig,
  path: string,
  init: RequestInit,
  onEvent: (name: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      accept: "text/event-stream",
    },
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText} on ${path}${detail ? `: ${detail}` : ""}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE messages are separated by a blank line.
    let separatorIdx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE-parse pattern
    while ((separatorIdx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, separatorIdx);
      buffer = buffer.slice(separatorIdx + 2);
      let eventName = "message";
      let dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      let parsed: unknown = dataStr;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        // leave as string
      }
      onEvent(eventName, parsed);
    }
  }
}

export const api = {
  // ─── Secrets ─────────────────────────────────────────────────────────
  // Backend-centric auth lives on the readiness projection (getBackendsReadiness
  // below); the all-providers listing has no UI consumer. setApiKey/removeSecret
  // remain the mutation verbs the Backends page drives per-provider.
  setApiKey: (cfg: ApiConfig, provider: string, apiKey: string) =>
    callVoid(cfg, `/api/secrets/${encodeURIComponent(provider)}/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),
  removeSecret: (cfg: ApiConfig, provider: string) =>
    callVoid(cfg, `/api/secrets/${encodeURIComponent(provider)}`, { method: "DELETE" }),

  // ─── Backends ────────────────────────────────────────────────────────
  // Detected CLI agent backends with health + version (ADR-0016). Re-probes
  // on every call. Consumed by the composer's Worker-only backend picker.
  listBackends: (cfg: ApiConfig) => call<BackendStatus[]>(cfg, "/api/backends"),
  // Per-backend readiness: health ∩ provider auth state. Feeds the Settings
  // "Backends" page (one card per backend). Re-probes on every call.
  getBackendsReadiness: (cfg: ApiConfig) =>
    call<BackendReadiness[]>(cfg, "/api/backends/readiness"),
  // Delegate to the backend CLI's OWN updater, then re-probe. Returns the fresh
  // status on success; throws on a 4xx/5xx (updater missing / failed / timeout).
  upgradeBackend: (cfg: ApiConfig, backend: "claude-code" | "codex") =>
    call<BackendStatus>(cfg, `/api/backends/${encodeURIComponent(backend)}/upgrade`, {
      method: "POST",
    }),

  // ─── Appearance ────────────────────────────────────────────────────
  // Theming module talks to this through a thin wrapper in
  // `theming-hive-persistence.ts`. The wire shape IS the theming
  // module's `Preferences` type — no parallel wire definition.
  // (Server-side the route is plumbed through the Config module under
  // the `appearance` key per the fold.)
  getAppearance: (cfg: ApiConfig) => call<Preferences>(cfg, "/api/appearance"),
  putAppearance: (cfg: ApiConfig, prefs: Preferences) =>
    call<Preferences>(cfg, "/api/appearance", {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),

  // ─── Kit (capability deploy-manager) ─────────────────────────────────
  // Full catalog from the synced Mirror (entries + presets + load problems).
  getKitCatalog: (cfg: ApiConfig) => call<Catalog>(cfg, "/api/kit/catalog"),
  // Sync status (freshness state + SHA) + the Deployment Ledger.
  getKitState: (cfg: ApiConfig) => call<KitState>(cfg, "/api/kit/state"),
  // On-disk self-check: per-capability per-target status (present/missing/drifted/
  // recorded). Read-only — no audit row. The page runs this on load and after deploy.
  getKitVerify: (cfg: ApiConfig) => call<VerifyReport>(cfg, "/api/kit/verify"),
  // Check for updates: fetch the latest Kit into the Mirror. Returns the
  // resulting sync state; the catalog/state queries are re-fetched after.
  syncKit: (cfg: ApiConfig) =>
    call<{ status: "synced" | "unchanged"; state: SyncStatus }>(cfg, "/api/kit/sync", {
      method: "POST",
    }),
  // Compute the Deploy Diff for a Selection (added/removed/changed).
  kitDiff: (cfg: ApiConfig, selection: Selection) =>
    call<DeployDiff>(cfg, "/api/kit/diff", {
      method: "POST",
      body: JSON.stringify(selection),
    }),
  // Apply a Selection. Returns the per-kind result.
  kitDeploy: (cfg: ApiConfig, selection: Selection) =>
    call<DeployResult>(cfg, "/api/kit/deploy", {
      method: "POST",
      body: JSON.stringify(selection),
    }),
};
