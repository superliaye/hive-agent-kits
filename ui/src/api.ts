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
    __hive?: { baseUrl: string; token: string };
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

async function call<T>(
  cfg: ApiConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
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
