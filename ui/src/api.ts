// Daemon API client. Reads baseUrl + token from:
//   1. window.__hive (provided by Electron preload)
//   2. URL query string ?baseUrl=...&token=... (dev mode in a browser tab)

// AgentBackend ids the daemon knows. Mirrors the daemon's `AgentBackend` Zod
// enum (src/lib/capability-types.ts); the UI is a separate Vite bundle, so this
// literal is kept in sync by hand. Both are vendor-SDK backends (ADR-0019 dropped
// the native in-process loop).
export type AgentBackend = "claude-code" | "codex";

const AGENT_BACKENDS: readonly AgentBackend[] = ["claude-code", "codex"];

// Narrow an `unknown` (e.g. a stored scope backend or an agent's harness
// `backend`) to an AgentBackend, cast-free.
export function isAgentBackend(v: unknown): v is AgentBackend {
  return typeof v === "string" && (AGENT_BACKENDS as readonly string[]).includes(v);
}

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
  // Per-Agent `run_shell` command allowlist (read-only here). Absent/empty ⇒
  // deny-all (no commands allowed). Mirrors the daemon's AgentDetailWire field.
  commandAllowlist?: string[];
  forkError?: string;
};

// Backend availability status (GET /api/backends). Mirrors the daemon's
// BackendStatus wire shape (src/backend-probe/types.ts). `backend` is a
// CLI-driven (probeable) backend; `native` is never probed.
export type BackendStatus = {
  backend: "claude-code" | "codex";
  installed: boolean;
  version: string | null;
  reason: "ok" | "not_installed" | "probe_failed" | "version_unreadable" | "timeout";
  checkedAt: number;
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

export type ConfiguredProvider = {
  provider: string;
  kind: "apiKey" | "oauth";
  status: "ok" | "expired";
  addedAt: number;
  refreshedAt?: number;
};

// Thinking-effort levels. Deliberate cross-package mirror of the daemon's
// canonical `EFFORT_ORDER` / `ThinkingEffort` (src/lib/effort.ts):
// the UI is a separate Vite bundle and does not import daemon source, so this
// literal is kept in sync by hand. If `EFFORT_ORDER` is widened/narrowed there,
// update this list to match.
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_EFFORTS: readonly ThinkingEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// Symbolic default tokens (ADR-0015 S2). A default tier (harness config, agent
// default, or Thread scope) may carry one of these rule-tokens instead of a
// pinned id; the daemon resolves them at Run start. Kept in sync with
// src/runs/symbolic.ts by hand (the UI is a separate Vite bundle).
export const SYMBOLIC_MODEL_LATEST = "latest";
export const SYMBOLIC_EFFORT_HIGHEST = "highest";

// Narrow an `unknown` (e.g. an Agent's harness `config.thinkingEffort`) to a
// ThinkingEffort, cast-free.
export function isThinkingEffort(v: unknown): v is ThinkingEffort {
  return typeof v === "string" && (THINKING_EFFORTS as readonly string[]).includes(v);
}

// A model the daemon can route (configured + routable). `model` is the
// "provider/modelId" string sent as a Run's modelOverride / agent pref.
// Mirrors the daemon's AvailableModel wire shape (GET /api/models).
export type AvailableModel = {
  provider: string;
  modelId: string;
  model: string;
  label?: string;
  // Supported thinking-effort levels (always includes "off").
  efforts: ThinkingEffort[];
};

// Which configured models actually take effect for a given Agent Backend, so a
// UI can constrain its model picker rather than present an incoherent
// backend+model pair (e.g. claude-code + an openai model). Each vendor SDK is
// scoped to its own provider's models: `claude-code` forwards anthropic models;
// `codex` forwards openai-codex models. A null backend (unresolved) shows all.
export function forwardableModels(
  models: AvailableModel[],
  backend: AgentBackend | null,
): AvailableModel[] {
  if (backend === null) return models;
  if (backend === "claude-code") return models.filter((m) => m.provider === "anthropic");
  if (backend === "codex") return models.filter((m) => m.provider === "openai-codex");
  return [];
}

// ─── Threads + Runs ────────────────────────────────────────────────────

// Canonical ContentBlock lives in the daemon's lib/messages. The UI imports it
// directly (rather than mirroring) so a new block kind added on the server
// surfaces as a TypeScript error in the UI's discriminated `renderBlock`
// switches — no silent drift.
import type { ContentBlock } from "../../src/lib/messages.ts";
import type { Preferences } from "./theming/index.ts";
export type { ContentBlock };

export type ThreadSummary = {
  id: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  titleSource: "auto" | "manual";
  archivedAt: number | null;
  status: "idle" | "running" | "unread" | "failed";
};

export type ThreadMessage = {
  id: string;
  idx: number;
  role: "user" | "assistant";
  content: ContentBlock[];
  createdAt: number;
};

export type ThreadDetail = ThreadSummary & { messages: ThreadMessage[] };

export type RunInfo = {
  id: string;
  threadId: string;
  agentId: string;
  model: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
};

// ─── RunEvent types — match server's runs/types.ts. ─────────────────────

export type BackendStreamEventWire =
  | { type: "text_start"; blockIndex: number }
  | { type: "text_delta"; blockIndex: number; delta: string }
  | { type: "text_end"; blockIndex: number }
  | { type: "thinking_start"; blockIndex: number }
  | { type: "thinking_delta"; blockIndex: number; delta: string }
  | { type: "thinking_end"; blockIndex: number; providerMetadata?: Record<string, unknown> }
  | { type: "refusal_delta"; delta: string }
  | { type: "tool_use_start"; blockIndex: number; id: string; name: string }
  | { type: "tool_use_delta"; blockIndex: number; id: string; delta: string }
  | { type: "tool_use_end"; blockIndex: number; id: string; args: unknown }
  | {
      type: "server_tool";
      blockIndex: number;
      id: string;
      name: string;
      phase: "start" | "progress" | "result";
      payload?: unknown;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: "done"; finishReason: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

export type RunEventWire =
  | {
      type: "run.started";
      runId: string;
      threadId: string;
      agentId: string;
      model: string;
      ts: number;
    }
  | { type: "model.event"; runId: string; event: BackendStreamEventWire }
  | {
      type: "run.completed";
      runId: string;
      finishReason: string;
      finalMessage: ThreadMessage;
      ts: number;
    }
  | {
      type: "run.failed";
      runId: string;
      error: { code: string; message: string };
      ts: number;
    }
  | { type: "run.cancelled"; runId: string; ts: number };

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

  // ─── Secrets ─────────────────────────────────────────────────────────
  listSecrets: (cfg: ApiConfig) => call<ConfiguredProvider[]>(cfg, "/api/secrets"),
  setApiKey: (cfg: ApiConfig, provider: string, apiKey: string) =>
    callVoid(cfg, `/api/secrets/${encodeURIComponent(provider)}/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),
  removeSecret: (cfg: ApiConfig, provider: string) =>
    callVoid(cfg, `/api/secrets/${encodeURIComponent(provider)}`, { method: "DELETE" }),

  // ─── Models + per-agent model preference ─────────────────────────────
  // Models the user can actually run (configured providers ∩ routable).
  listModels: (cfg: ApiConfig) => call<AvailableModel[]>(cfg, "/api/models"),
  // The agent's sticky model + effort defaults; each is null when unset (the
  // executor then falls back to the harness config.model / config.thinkingEffort).
  getAgentModelPref: (cfg: ApiConfig, agentId: string) =>
    call<{ model: string | null; effort: ThinkingEffort | null; backend: AgentBackend | null }>(
      cfg,
      `/api/agents/${encodeURIComponent(agentId)}/model-pref`,
    ),
  // Merge semantics: omit a field to leave its stored value unchanged. Pass at
  // least one of { model, effort, backend }. `backend: null` clears the stored
  // backend default. Apply-to-default widens to the backend axis (OQ-2).
  setAgentModelPref: (
    cfg: ApiConfig,
    agentId: string,
    patch: { model?: string; effort?: ThinkingEffort; backend?: AgentBackend | null },
  ) =>
    call<{ model: string | null; effort: ThinkingEffort | null; backend: AgentBackend | null }>(
      cfg,
      `/api/agents/${encodeURIComponent(agentId)}/model-pref`,
      {
        method: "PUT",
        body: JSON.stringify(patch),
      },
    ),

  // ─── Backends ────────────────────────────────────────────────────────
  // Detected CLI agent backends with health + version (ADR-0016). Re-probes
  // on every call.
  listBackends: (cfg: ApiConfig) => call<BackendStatus[]>(cfg, "/api/backends"),
  // Delegate to the backend CLI's OWN updater, then re-probe. Returns the fresh
  // status on success; throws on a 4xx/5xx (updater missing / failed / timeout).
  upgradeBackend: (cfg: ApiConfig, backend: "claude-code" | "codex") =>
    call<BackendStatus>(cfg, `/api/backends/${encodeURIComponent(backend)}/upgrade`, {
      method: "POST",
    }),

  // ─── Threads ────────────────────────────────────────────────────────
  listThreads: (cfg: ApiConfig) => call<ThreadSummary[]>(cfg, "/api/threads"),
  createThread: (cfg: ApiConfig, agentId: string) =>
    call<ThreadSummary>(cfg, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),
  getThread: (cfg: ApiConfig, threadId: string) =>
    call<ThreadDetail>(cfg, `/api/threads/${encodeURIComponent(threadId)}`),
  deleteThread: (cfg: ApiConfig, threadId: string) =>
    callVoid(cfg, `/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
  setThreadTitle: (cfg: ApiConfig, threadId: string, title: string) =>
    call<ThreadSummary>(cfg, `/api/threads/${encodeURIComponent(threadId)}/title`, {
      method: "PUT",
      body: JSON.stringify({ title }),
    }),
  // The Thread's conversation-scope model/effort pick (ADR-0015 S1); each is
  // null when unset (the executor then falls back to the agent default). May be
  // a symbolic token ("latest"/"highest").
  getThreadScope: (cfg: ApiConfig, threadId: string) =>
    call<{ model: string | null; effort: string | null; backend: AgentBackend | null }>(
      cfg,
      `/api/threads/${encodeURIComponent(threadId)}/scope`,
    ),
  // Use-here: applies to THIS Thread only (sticks for its later Runs), without
  // touching the agent default. Merge semantics — omit a field to leave it
  // unchanged; pass null to clear an axis. Apply-to-default is the separate
  // setAgentModelPref act. The backend axis is Worker-only (the daemon rejects a
  // non-native backend for Root / Agent Manager).
  setThreadScope: (
    cfg: ApiConfig,
    threadId: string,
    patch: { model?: string | null; effort?: ThinkingEffort | null; backend?: AgentBackend | null },
  ) =>
    call<{ model: string | null; effort: string | null; backend: AgentBackend | null }>(
      cfg,
      `/api/threads/${encodeURIComponent(threadId)}/scope`,
      {
        method: "PUT",
        body: JSON.stringify(patch),
      },
    ),
  archiveThread: (cfg: ApiConfig, threadId: string) =>
    call<ThreadSummary>(cfg, `/api/threads/${encodeURIComponent(threadId)}/archive`, {
      method: "POST",
    }),
  markThreadRead: (cfg: ApiConfig, threadId: string) =>
    callVoid(cfg, `/api/threads/${encodeURIComponent(threadId)}/read`, { method: "POST" }),
  markThreadUnread: (cfg: ApiConfig, threadId: string) =>
    callVoid(cfg, `/api/threads/${encodeURIComponent(threadId)}/unread`, { method: "POST" }),
  listRuns: (cfg: ApiConfig, threadId: string) =>
    call<RunInfo[]>(cfg, `/api/threads/${encodeURIComponent(threadId)}/runs`),

  // ─── Runs ───────────────────────────────────────────────────────────
  /**
   * Start a Run on a thread. SSE: events are typed; consumer dispatches on
   * `event.type` to apply lifecycle / model deltas to local state.
   */
  startRun: (
    cfg: ApiConfig,
    threadId: string,
    userMessage: ContentBlock[],
    onEvent: (event: RunEventWire) => void,
    options: { modelOverride?: string; effortOverride?: ThinkingEffort; signal?: AbortSignal } = {},
  ) => {
    const body: {
      userMessage: ContentBlock[];
      modelOverride?: string;
      effortOverride?: ThinkingEffort;
    } = { userMessage };
    if (options.modelOverride) body.modelOverride = options.modelOverride;
    if (options.effortOverride) body.effortOverride = options.effortOverride;
    return consumeSSE(
      cfg,
      `/api/threads/${encodeURIComponent(threadId)}/runs`,
      { method: "POST", body: JSON.stringify(body) },
      (_eventName, data) => {
        // `data` is the JSON-parsed RunEvent; `event:` name matches `data.type`.
        onEvent(data as RunEventWire);
      },
      options.signal,
    );
  },
  cancelRun: (cfg: ApiConfig, runId: string) =>
    callVoid(cfg, `/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  getRun: (cfg: ApiConfig, runId: string) =>
    call<RunInfo>(cfg, `/api/runs/${encodeURIComponent(runId)}`),

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
};
