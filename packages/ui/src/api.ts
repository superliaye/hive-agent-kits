// Daemon API client. Reads baseUrl + token from:
//   1. window.__hive (provided by Electron preload)
//   2. URL query string ?baseUrl=...&token=... (dev mode in a browser tab)
//
// Wire types are sourced from @hive/contract (the single source of truth). The
// kit names use the contract's canonical unprefixed form.

import type {
  AcceptedDeployRequest,
  AcceptedDeployResponse,
  AddSourceResult,
  BackendReadiness,
  BackendStatus,
  Catalog,
  DeployDiff,
  DeployResult,
  KitState,
  Selection,
  SelectionMutation,
  SelectionSnapshot,
  Source,
  SyncRunResult,
  VerifyReport,
} from "@hive/contract";
import {
  AcceptedDeployResponse as AcceptedDeployResponseSchema,
  AddSourceResult as AddSourceResultSchema,
  DeploymentOverview as DeploymentOverviewSchema,
  SelectionSnapshot as SelectionSnapshotSchema,
} from "@hive/contract";
import type { Preferences } from "@hive/theming";

export type {
  AcceptedDeployRequest,
  AcceptedDeployResponse,
  AddSourceResult,
  BackendAuthState,
  BackendReadiness,
  BackendStatus,
  CapabilityEntry,
  CapabilityKind,
  Catalog,
  CatalogProblem,
  DeployDiff,
  DeploymentOverview,
  DeployResult,
  DeployTarget,
  DiffEntry,
  KindResult,
  KitState,
  Ledger,
  OverviewLastAttempt,
  OverviewMirror,
  OverviewRow,
  OverviewSource,
  PresetSummary,
  ReconciliationState,
  Selection,
  SelectionMutation,
  SelectionSnapshot,
  Source,
  SourceSyncStatus,
  SourceValidationReport,
  StoredSecretMeta,
  SyncRunResult,
  SyncStatus,
  SyncStatusState,
  TargetObservation,
  VerifyEntry,
  VerifyReport,
  VerifyStatus,
  VerifyTargetStatus,
} from "@hive/contract";

declare global {
  interface Window {
    __hive?: {
      connection?: {
        kind: "managed" | "external";
        displayName: string;
        status: "connected" | "disconnected";
      };
      daemon?: {
        request: (
          path: string,
          init: { method?: string; headers?: Record<string, string>; body?: string },
        ) => Promise<{ status: number; statusText: string; body: string }>;
      };
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

export type ApiConfig =
  | { baseUrl: string; token: string }
  | {
      request: NonNullable<NonNullable<Window["__hive"]>["daemon"]>["request"];
    };

// Developer config slice — mirrors the daemon's DeveloperConfigSchema. Kept
// local to the UI client (a tiny boolean slice, no contract entry warranted).
export type DeveloperConfig = { allowRealHomeDeploy: boolean };

export function resolveApiConfig(): ApiConfig {
  if (typeof window !== "undefined" && window.__hive?.daemon) {
    return { request: window.__hive.daemon.request };
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const baseUrl = params.get("baseUrl") ?? "http://127.0.0.1:3117";
    const token = params.get("token") ?? "";
    return { baseUrl, token };
  }
  return { baseUrl: "http://127.0.0.1:3117", token: "" };
}

async function request(cfg: ApiConfig, path: string, init: RequestInit = {}): Promise<Response> {
  if ("request" in cfg) {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const serialized = await cfg.request(path, {
      method: init.method,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const body = serialized.body === "" ? null : serialized.body;
    return new Response(body, { status: serialized.status, statusText: serialized.statusText });
  }
  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

async function call<T>(cfg: ApiConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(cfg, path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}`);
  }
  return (await res.json()) as T;
}

async function callVoid(cfg: ApiConfig, path: string, init: RequestInit = {}): Promise<void> {
  const res = await request(cfg, path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
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
  const res = await request(cfg, path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
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

// POST /api/sources error, carrying the server's structured body so the
// Add-Source control can render it. A transport concern, not a wire contract, so
// it lives here (not @hive/contract). `cause` is the parsed body discriminated by
// `kind`: the 400 issue list, the 409 duplicate origin, or a generic message —
// the three server error shapes differ, so each is narrowed separately. `kind`
// (not `status`) is the discriminant so the union narrows cleanly even though the
// generic case's `status` is a plain number.
export type AddSourceErrorCause =
  | { kind: "invalid"; status: 400; issues: { path: string; message: string }[] }
  | { kind: "duplicate"; status: 409; origin: string }
  // A 201 whose body fails the contract schema: the daemon already COMMITTED the
  // Source (registry.add runs before the 201 body is built), so the consumer must
  // still refetch to surface the new row — the banner is advisory, not a hard fail.
  | { kind: "malformed-success"; status: number; message: string }
  | { kind: "other"; status: number; message: string };

export class AddSourceError extends Error {
  readonly cause: AddSourceErrorCause;
  constructor(cause: AddSourceErrorCause, message: string) {
    super(message);
    this.name = "AddSourceError";
    this.cause = cause;
  }
}

export class SelectionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("Selection changed on the Daemon");
    this.name = "SelectionConflictError";
  }
}

export class PlanStaleError extends Error {
  constructor() {
    super("Deployment plan changed");
    this.name = "PlanStaleError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// 400 body: { error, issues: [{ path, message }] }. Keep only well-shaped issues.
function parse400Issues(body: unknown): { path: string; message: string }[] {
  if (!isRecord(body) || !Array.isArray(body.issues)) return [];
  const out: { path: string; message: string }[] = [];
  for (const raw of body.issues) {
    if (!isRecord(raw)) continue;
    const path = asString(raw.path);
    const message = asString(raw.message);
    if (message !== undefined) out.push({ path: path ?? "", message });
  }
  return out;
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

  // ─── Developer (deploy escape hatches) ───────────────────────────────
  // `allowRealHomeDeploy` opts a dev daemon into deploying to the real home
  // instead of the per-instance sandbox. Off by default; surfaced in the
  // Developer settings tab.
  getDeveloper: (cfg: ApiConfig) => call<DeveloperConfig>(cfg, "/api/developer"),
  putDeveloper: (cfg: ApiConfig, value: DeveloperConfig) =>
    call<DeveloperConfig>(cfg, "/api/developer", {
      method: "PUT",
      body: JSON.stringify(value),
    }),

  // ─── Kit (capability deploy-manager) ─────────────────────────────────
  getKitOverview: (cfg: ApiConfig) =>
    call<unknown>(cfg, "/api/kit/overview").then((body) => DeploymentOverviewSchema.parse(body)),
  patchKitSelection: (cfg: ApiConfig, mutation: SelectionMutation) =>
    patchKitSelection(cfg, mutation),
  acceptKitDeploy: (cfg: ApiConfig, requestBody: AcceptedDeployRequest) =>
    acceptKitDeploy(cfg, requestBody),
  // Full catalog from the synced Mirror (entries + presets + load problems).
  getKitCatalog: (cfg: ApiConfig) => call<Catalog>(cfg, "/api/kit/catalog"),
  // Sync status (freshness state + SHA) + the Deployment Ledger.
  getKitState: (cfg: ApiConfig) => call<KitState>(cfg, "/api/kit/state"),
  // On-disk self-check: per-capability per-target status (present/missing/drifted/
  // recorded). Read-only — no audit row. The page runs this on load and after deploy.
  getKitVerify: (cfg: ApiConfig) => call<VerifyReport>(cfg, "/api/kit/verify"),
  // Check for updates: sync every active Source into its Mirror. Returns the
  // per-Source outcomes; the catalog/state queries are re-fetched after.
  syncKit: (cfg: ApiConfig) =>
    call<SyncRunResult>(cfg, "/api/kit/sync", {
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

  // ─── Sources ─────────────────────────────────────────────────────────
  // The authoritative Source list, INCLUDING inactive sources (state.sync is
  // active-only). Drives the per-Source toggle rows in the Capabilities header.
  listSources: (cfg: ApiConfig) => call<Source[]>(cfg, "/api/sources"),
  // Register a Source by git URL. The daemon onboards it (sync + validate the
  // mirror) and returns a 201 AddSourceResult even for a non-conformant or empty
  // repo — the add is never rejected for that. Unlike `call<T>`, this reads the
  // error body so the control can surface the server's structured 400 issues /
  // 409 duplicate; on any non-201 it throws a typed `AddSourceError`.
  addSource: (cfg: ApiConfig, origin: string) => addSource(cfg, origin),
  // Flip a Source on/off. Activate/deactivate only change `active` (no sync) and
  // emit the source.activated/deactivated audit event server-side; the catalog is
  // built from active sources only, so the page re-fetches ["kit"] to reflect it.
  activateSource: (cfg: ApiConfig, id: string) =>
    call<Source>(cfg, `/api/sources/${encodeURIComponent(id)}/activate`, { method: "POST" }),
  deactivateSource: (cfg: ApiConfig, id: string) =>
    call<Source>(cfg, `/api/sources/${encodeURIComponent(id)}/deactivate`, { method: "POST" }),
  // Raise ("up") or lower ("down") a Source one precedence step. Returns the
  // updated Source. The page re-fetches ["sources"] (row order) + ["kit"] (the
  // catalog recomputes with the new precedence → shadows flip live).
  reorderSource: (cfg: ApiConfig, id: string, direction: "up" | "down") =>
    call<Source>(cfg, `/api/sources/${encodeURIComponent(id)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    }),
  // Remove a Source: drops the registry row + its Mirror + its catalog entries
  // (DELETE /api/sources/:id, 204 no body). Already-deployed files are NOT touched
  // — a deployed capability whose Source is gone is an orphan (kept, never
  // auto-removed). The page re-fetches ["sources"] (row gone) + ["kit"] (its
  // capabilities gone) on success.
  deleteSource: (cfg: ApiConfig, id: string) =>
    callVoid(cfg, `/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

async function addSource(cfg: ApiConfig, origin: string): Promise<AddSourceResult> {
  const path = "/api/sources";
  const res = await request(cfg, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      label: sourceLabel(origin),
      locator: {
        kind: "git",
        repoUrl: origin,
        revision: { mode: "track", ref: "refs/heads/main" },
        subpath: ".",
      },
    }),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.ok) {
    // Validate the success body against the contract schema (no `as` cast). A
    // malformed 201 is a server bug — surface it as a transport error.
    const parsed = AddSourceResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new AddSourceError(
        { kind: "malformed-success", status: res.status, message: "malformed add-source response" },
        "malformed add-source response",
      );
    }
    return parsed.data;
  }
  // Non-ok: discriminate the error body by status (the shapes differ — do not
  // share a guard). The structured `cause` is the SSOT; the consumer formats the
  // user-facing copy from it (Error.message stays a terse internal label).
  if (res.status === 400) {
    const issues = parse400Issues(body);
    throw new AddSourceError({ kind: "invalid", status: 400, issues }, "invalid source");
  }
  if (res.status === 409) {
    const carriedOrigin = isRecord(body) ? (asString(body.origin) ?? origin) : origin;
    throw new AddSourceError(
      { kind: "duplicate", status: 409, origin: carriedOrigin },
      "duplicate origin",
    );
  }
  // Any other status (incl. 500 `{ error, message }` and the body-less 500
  // `{ error, id }`): carry the server message if present, else fall back to
  // status text. Here the carried message IS the user-facing copy.
  const message =
    (isRecord(body) ? asString(body.message) : undefined) ?? `${res.status} ${res.statusText}`;
  throw new AddSourceError({ kind: "other", status: res.status, message }, message);
}

function sourceLabel(origin: string): string {
  try {
    const url = new URL(origin);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.slice(-2).join("/") || url.hostname;
  } catch {
    return origin;
  }
}

async function patchKitSelection(
  cfg: ApiConfig,
  mutation: SelectionMutation,
): Promise<SelectionSnapshot> {
  const path = "/api/kit/selection";
  const res = await request(cfg, path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  if (res.ok) return SelectionSnapshotSchema.parse(await res.json());
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 409 && isRecord(body) && body.error === "selection_conflict") {
    const currentRevision = body.currentRevision;
    throw new SelectionConflictError(
      typeof currentRevision === "number" ? currentRevision : mutation.expectedRevision,
    );
  }
  throw new Error(`${res.status} ${res.statusText} on ${path}`);
}

async function acceptKitDeploy(
  cfg: ApiConfig,
  requestBody: AcceptedDeployRequest,
): Promise<AcceptedDeployResponse> {
  const path = "/api/kit/deploy";
  const res = await request(cfg, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (res.ok) return AcceptedDeployResponseSchema.parse(await res.json());
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 409 && isRecord(body) && body.error === "plan_stale") {
    throw new PlanStaleError();
  }
  throw new Error(`${res.status} ${res.statusText} on ${path}`);
}
