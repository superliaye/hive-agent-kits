// Daemon API client. Reads baseUrl + token from:
//   1. window.__hive (provided by Electron preload)
//   2. URL query string ?baseUrl=...&token=... (dev mode in a browser tab)

export type AgentSummary = {
  agentId: string;
  backend: string;
  domain: string;
  layer: "bundled" | "runtime";
  hasFork: boolean;
  bindingCounts: {
    skills: number;
    snippets: number;
    tools: number;
    mcp: number;
  };
};

export type AgentDetail = AgentSummary & {
  bindings: {
    skills: string[];
    snippets: string[];
    tools: string[];
    mcp: string[];
  };
  config: Record<string, unknown>;
  promptBody: string;
  forkError?: string;
};

export type CapabilityWire = {
  name: string;
  kind: "skill" | "snippet" | "tool" | "mcp";
  description: string;
  origin: "personal" | "workplace";
  layer: "bundled" | "runtime";
  // How the Registry discovered this capability. Distinct from `upstream`
  // (where it was vendored from) — see src/server/types.ts.
  discovery: string;
  workplaceId?: string;
  shadows?: Array<{ layer: string; origin: string; workplaceId?: string }>;
  tags?: string[];
  upstream?: { url: string; ref: string };
};

export type BindingPatch = {
  kind: "skill" | "snippet" | "tool" | "mcp";
  name: string;
  action: "bind" | "unbind";
};

declare global {
  interface Window {
    __hive?: {
      baseUrl: string;
      token: string;
      // Open an http(s) URL in the user's default external browser. Only
      // present in Electron (preload bridge). Use the `openUrl()` helper
      // below instead of touching this directly — it falls back to
      // `window.open()` in browser-tab mode (Vite dev).
      openExternal?: (url: string) => Promise<void>;
    };
  }
}

/**
 * Open an http(s) URL in the user's default external browser.
 *
 * In Electron: calls the preload bridge → main process's
 * `shell.openExternal(url)`. The OAuth login flow uses this so the user's
 * real browser handles the Anthropic consent screen, not the in-app
 * webview.
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

export const api = {
  listAgents: (cfg: ApiConfig) => call<AgentSummary[]>(cfg, "/api/agents"),
  getAgent: (cfg: ApiConfig, id: string) => call<AgentDetail>(cfg, `/api/agents/${id}`),
  patchBindings: (cfg: ApiConfig, id: string, patches: BindingPatch[]) =>
    call<AgentDetail>(cfg, `/api/agents/${id}/bindings`, {
      method: "PATCH",
      body: JSON.stringify({ patches }),
    }),
  resetAgent: (cfg: ApiConfig, id: string) =>
    call<AgentDetail>(cfg, `/api/agents/${id}/reset`, { method: "POST" }),
  listCapabilities: (cfg: ApiConfig, kind?: CapabilityWire["kind"]) =>
    call<CapabilityWire[]>(cfg, `/api/capabilities${kind ? `?kind=${kind}` : ""}`),
};
