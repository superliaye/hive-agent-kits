// ChatPage — top-level layout for chat. Two columns:
//   - Sidebar: thread list grouped by agent (collapsible), paginated,
//     status dots, right-click context menu, live updates via /api/events.
//   - Main: message panel + composer for the selected thread, with an
//     inline-editable header title.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentBackend,
  type ApiConfig,
  type AvailableModel,
  type BackendStatus,
  type ContentBlock,
  type ThinkingEffort,
  type ThreadSummary,
  SYMBOLIC_EFFORT_HIGHEST,
  SYMBOLIC_MODEL_LATEST,
  THINKING_EFFORTS,
  api,
  isAgentBackend,
  isThinkingEffort,
} from "../api.ts";
import { resolveAxis } from "../axis-precedence.ts";
import { InlineTitle } from "../components/InlineTitle.tsx";
import { type BackendOption, MessageComposer } from "../components/MessageComposer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { NewThreadModal } from "../components/NewThreadModal.tsx";
import {
  type ThreadMenuAction,
  ThreadContextMenu,
} from "../components/ThreadContextMenu.tsx";
import { useChatThread } from "../hooks/useChatThread.ts";
import {
  groupByAgent,
  paginate,
  RUN_WIRE_EVENTS,
  statusMeta,
  threadTitle,
  UNTITLED_PLACEHOLDER,
} from "../thread-nav.ts";

const COLLAPSE_KEY = "hive.chat.collapsedAgents";

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
  } catch {
    // ignore malformed/absent storage
  }
  return {};
}

// The three promotable picker axes (P8): apply-to-default is expressed once,
// parameterised by axis, rather than copy-pasted per axis.
type ApplyAxis = "model" | "effort" | "backend";

// A promotable axis row, GENERIC over its concrete value type V (P10): model
// carries `string`, effort `ThinkingEffort`, backend `AgentBackend`. Each axis
// brings its own typed `setDefault`, so promoting a pick to the agent default
// needs NO `as`-cast at the seam.
type ApplyRow<V extends string> = {
  axis: ApplyAxis;
  noun: string;
  value: V | null;
  defaultLabel: string;
  // The per-axis guard: the row renders only when the conversation pick differs
  // from the agent default. Kept explicit so per-axis promotability survives.
  enabled: boolean;
  // Promote this axis's pick to the agent default on the daemon (typed per axis,
  // so the API patch field carries V at its own concrete type — no cast).
  write: (agentId: string, value: V) => Promise<unknown>;
  // Update the local agent-default state for this axis (typed per axis — the
  // cast that previously narrowed `string` back to V is gone).
  setDefault: (value: V) => void;
  testId: string;
};

// The display-side view of a row: the generic `ApplyRow<V>` collapsed to its
// render fields plus a pre-bound zero-arg apply thunk. The thunk is built at the
// row's construction site where V is still concrete (see `makeApplyView`), so
// the heterogeneous rows can be iterated uniformly without a discriminated
// union and without re-widening V at the render site.
type ApplyRowView = {
  axis: ApplyAxis;
  noun: string;
  value: string;
  defaultLabel: string;
  testId: string;
  onApply: () => void;
};

// One axis-parameterised apply-to-default row (P8/P9). Standardized copy across
// all three axes; the button is a ghost "Update" (P9). Outcomes land on the
// page's list-error channel — this row carries no local status line.
function ApplyToDefault({ row }: { row: ApplyRowView }): JSX.Element {
  return (
    <div className="composer-apply-default">
      <span className="meta">
        This conversation uses {row.noun} <strong>{row.value}</strong> (agent default:{" "}
        {row.defaultLabel}).
      </span>
      <button
        type="button"
        className="button ghost small"
        onClick={row.onApply}
        data-testid={row.testId}
      >
        Update
      </button>
    </div>
  );
}

export function ChatPage({
  apiConfig,
  onNavigateToSecrets,
}: {
  apiConfig: ApiConfig;
  onNavigateToSecrets: () => void;
}): JSX.Element {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Per-agent collapse + pagination, both client-only. Collapse persists to
  // localStorage; pagination is ephemeral (resets on reload).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // The row whose context menu is open, plus its viewport coordinates.
  const [menu, setMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);
  // The thread whose title is being inline-edited (header editor, also opened
  // by the menu's Rename). At most one editor is open.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Model selection for the active agent.
  //   models       — what the user can actually run (configured ∩ routable).
  //   agentDefault — the agent's stored default (saved pref, else harness
  //                  config.model); may not be a runnable model.
  //   userPick     — an explicit in-session choice (null until the user picks).
  // The effective selection (below) prefers the user's pick, then the agent
  // default *if runnable*, else the latest available model — so a new
  // conversation never starts on an unavailable model when runnable ones exist.
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [agentDefault, setAgentDefault] = useState<string | null>(null);
  const [userPick, setUserPick] = useState<string | null>(null);
  // Effort selection mirrors the model: agent default (saved pref, else harness
  // config.thinkingEffort) and an explicit in-session pick. The effective effort
  // (below) is derived against the *selected model's* supported levels, so an
  // incompatible stored effort is dropped when the model changes. The default may
  // carry the symbolic "highest" token (ADR-0015 S2), mirroring model's "latest".
  const [effortDefault, setEffortDefault] = useState<
    ThinkingEffort | typeof SYMBOLIC_EFFORT_HIGHEST | null
  >(null);
  const [effortPick, setEffortPick] = useState<ThinkingEffort | null>(null);
  // Agent-Backend axis (ADR-0015), Worker-only. `backendStatuses` is the daemon
  // probe (which CLI backends are installed + healthy); `isWorker` gates the
  // picker (daemon-supplied — never hardcoded ids). `backendDefault` is the
  // agent default (saved pref, else the harness-authored backend); `backendPick`
  // an explicit in-session choice. Same default/pick shape as model/effort.
  const [backendStatuses, setBackendStatuses] = useState<BackendStatus[]>([]);
  const [isWorker, setIsWorker] = useState(false);
  const [backendDefault, setBackendDefault] = useState<AgentBackend | null>(null);
  const [backendPick, setBackendPick] = useState<AgentBackend | null>(null);

  // Effective selection per axis follows ONE pick > default > fallback ordering
  // (P11), shared via `resolveAxis`; each axis supplies its own offerability and
  // fallback. Model: the pick is taken unconditionally; the stored default holds
  // only if runnable; else the latest runnable model (so a new conversation never
  // starts on an unavailable model when runnable ones exist).
  const selectedModel: string | null = resolveAxis<string>({
    pick: userPick,
    pickValid: () => true,
    def: agentDefault,
    defOfferable: (m) => models.some((x) => x.model === m),
    fallback: models[0]?.model ?? agentDefault,
  });

  // The supported effort levels for the currently-selected model (the picker's
  // options). Empty when the selection isn't a known/runnable model.
  const selectedModelEfforts: ThinkingEffort[] =
    models.find((m) => m.model === selectedModel)?.efforts ?? [];

  // Effective effort: the user's in-session pick if still valid for this model,
  // else the agent default if valid, else the model's first supported level —
  // so switching to a model that doesn't support the stored effort never leaves
  // an invalid level selected. null only when the model exposes no efforts.
  const selectedEffort: ThinkingEffort | null = resolveAxis<ThinkingEffort>({
    pick: effortPick,
    pickValid: (e) => selectedModelEfforts.includes(e),
    // A symbolic "highest" default is never directly offerable as a concrete
    // level; drop it here so the resolver falls through to the model's strongest
    // supported level (the daemon resolves "highest" the same way at Run start).
    def: isThinkingEffort(effortDefault) ? effortDefault : null,
    defOfferable: (e) => selectedModelEfforts.includes(e),
    fallback: selectedModelEfforts[0] ?? null,
  });

  // The composer hides the effort picker for a model whose only level is "off"
  // (no real reasoning choice). Match that here so the send carries no
  // effortOverride for such models — a bare "off" would be a meaningless no-op.
  const hasRealEffort = selectedModelEfforts.some((eff) => eff !== "off");
  const effortToSend: ThinkingEffort | null = hasRealEffort ? selectedEffort : null;

  // Resolve a SYMBOLIC agent default (ADR-0015 S2) the same way the daemon does
  // at Run start, so the UI can both gate the apply-to-default rows against the
  // RESOLVED default and surface "<token> → <resolved>" in the label. "latest"
  // resolves to the head of the runnable catalog (GET /api/models is that list,
  // newest-first), and "highest" to the strongest level the SELECTED model
  // supports, by THINKING_EFFORTS index. Backend is never symbolic.
  const resolvedDefaultModel: string | null =
    agentDefault === SYMBOLIC_MODEL_LATEST ? (models[0]?.model ?? null) : agentDefault;
  const resolvedDefaultEffort: ThinkingEffort | null =
    effortDefault === SYMBOLIC_EFFORT_HIGHEST
      ? (selectedModelEfforts.reduce<ThinkingEffort | null>(
          (best, e) =>
            best === null || THINKING_EFFORTS.indexOf(e) > THINKING_EFFORTS.indexOf(best)
              ? e
              : best,
          null,
        ) ?? null)
      : effortDefault;
  const modelDefaultLabel: string =
    agentDefault === SYMBOLIC_MODEL_LATEST && resolvedDefaultModel
      ? `${agentDefault} → ${resolvedDefaultModel}`
      : (agentDefault ?? "none");
  const effortDefaultLabel: string =
    effortDefault === SYMBOLIC_EFFORT_HIGHEST && resolvedDefaultEffort
      ? `${effortDefault} → ${resolvedDefaultEffort}`
      : (effortDefault ?? "none");

  // Offerable backends: the synthetic `native` (always available, in-process)
  // plus each installed + healthy CLI backend, labelled with its detected
  // version. The picker is Worker-only (gated below on `isWorker`).
  const backendOptions: BackendOption[] = [
    { backend: "native", label: "native" },
    ...backendStatuses
      .filter((s) => s.installed && s.reason === "ok")
      .map<BackendOption>((s) => ({
        backend: s.backend,
        label: s.version ? `${s.backend} ${s.version}` : s.backend,
      })),
  ];

  // Effective backend selection: the in-session pick, else the agent default if
  // offerable, else `native` (always available). Mirrors the model tier.
  const selectedBackend: AgentBackend | null = resolveAxis<AgentBackend>({
    pick: backendPick,
    pickValid: () => true,
    def: backendDefault,
    defOfferable: (b) => backendOptions.some((o) => o.backend === b),
    fallback: "native",
  });

  // Apply-to-default affordances (ADR-0015:22, P8/P9): all three axes
  // (model + effort + backend) are promotable, expressed as ONE axis-parameterised
  // row component fed by a generic `ApplyRow<V>` per axis. Each row carries its own
  // `enabled` guard (the pick differs from the agent default) so per-axis
  // promotability is preserved — no "Apply all". Each row is typed at its own
  // concrete V, so `setDefault` needs NO cast (P10).
  // A row renders ONLY when the user made an explicit per-conversation pick
  // (userPick/effortPick/backendPick non-null) that differs from the RESOLVED
  // default — so a fresh, uncustomized conversation (all picks null) shows no
  // apply-to-default rows even when the agent default is symbolic.
  const modelRow: ApplyRow<string> = {
    axis: "model",
    noun: "model",
    value: selectedModel,
    defaultLabel: modelDefaultLabel,
    enabled:
      userPick !== null &&
      userPick !== resolvedDefaultModel &&
      models.some((m) => m.model === userPick),
    write: (id, v) => api.setAgentModelPref(apiConfig, id, { model: v }),
    setDefault: (v) => setAgentDefault(v),
    testId: "apply-model-default",
  };
  const effortRow: ApplyRow<ThinkingEffort> = {
    axis: "effort",
    noun: "effort",
    value: effortToSend,
    defaultLabel: effortDefaultLabel,
    enabled: effortPick !== null && hasRealEffort && effortPick !== resolvedDefaultEffort,
    write: (id, v) => api.setAgentModelPref(apiConfig, id, { effort: v }),
    setDefault: (v) => setEffortDefault(v),
    testId: "apply-effort-default",
  };
  const backendRow: ApplyRow<AgentBackend> = {
    axis: "backend",
    noun: "backend",
    value: selectedBackend,
    // Backend always resolves to native, so the default fallback is native
    // (not "none") — intentional, kept distinct from the model/effort fallback.
    // Backend is never symbolic, so the label stays the raw default.
    defaultLabel: backendDefault ?? "native",
    enabled:
      isWorker && backendPick !== null && backendPick !== (backendDefault ?? "native"),
    write: (id, v) => api.setAgentModelPref(apiConfig, id, { backend: v }),
    setDefault: (v) => setBackendDefault(v),
    testId: "apply-backend-default",
  };

  // Keep activeId stable across live refetches: only auto-select when nothing
  // is selected, or when the selected thread has disappeared.
  const reconcileSelection = useCallback((list: ThreadSummary[]): void => {
    setActiveId((cur) => {
      if (cur === null) return list[0]?.id ?? null;
      if (!list.find((t) => t.id === cur)) return list[0]?.id ?? null;
      return cur;
    });
  }, []);

  const refreshThreads = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listThreads(apiConfig);
      setThreads(list);
      setListError(null);
      reconcileSelection(list);
    } catch (err) {
      setListError((err as Error).message);
    }
  }, [apiConfig, reconcileSelection]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const thread = useChatThread(apiConfig, activeId);
  const agentId = thread.thread?.agentId ?? null;

  // ─── Live thread-list updates via /api/events ──────────────────────────
  // ChatPage owns the active thread's timeline (useChatThread); the nav's
  // thread-LIST status dots are a separate concern. A dedicated EventSource
  // refetches the list when any run lifecycle envelope arrives, so a Run
  // started/finished on a thread NOT driven by this page's composer updates
  // its dot live. (useState model, not Query — kept local, mirrors the
  // composer's imperative state.)
  const refreshRef = useRef(refreshThreads);
  refreshRef.current = refreshThreads;
  useEffect(() => {
    if (!apiConfig.token) return;
    const url = `${apiConfig.baseUrl}/api/events?token=${encodeURIComponent(apiConfig.token)}`;
    const source = new EventSource(url);
    const onRun = (): void => {
      void refreshRef.current();
    };
    // Subscribe to the double-prefixed SSE wire names (RUN_WIRE_EVENTS), not the
    // run-envelope types. The names are pinned against drift in
    // thread-nav.run-wire.test.ts (UI) / routes-threads-runs.test.ts (daemon).
    for (const event of RUN_WIRE_EVENTS) {
      source.addEventListener(event, onRun);
    }
    return () => source.close();
  }, [apiConfig.baseUrl, apiConfig.token]);

  // Load the runnable-models catalog once (and when the daemon config changes).
  useEffect(() => {
    let cancelled = false;
    void api
      .listModels(apiConfig)
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiConfig]);

  // Load the backend availability probe once (ADR-0016). Feeds the composer's
  // Worker-only backend picker with the installed CLI backends + versions.
  useEffect(() => {
    let cancelled = false;
    void api
      .listBackends(apiConfig)
      .then((b) => {
        if (!cancelled) setBackendStatuses(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiConfig]);

  // Load the active agent's stored defaults (saved pref, else harness config),
  // for both model and effort, and clear any prior in-session picks.
  useEffect(() => {
    if (!agentId) {
      setAgentDefault(null);
      setEffortDefault(null);
      setBackendDefault(null);
      setIsWorker(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [pref, agent] = await Promise.all([
          api.getAgentModelPref(apiConfig, agentId),
          api.getAgent(apiConfig, agentId),
        ]);
        if (cancelled) return;
        // The model/effort defaults may be a concrete id OR a symbolic token
        // ("latest"/"highest", ADR-0015 S2) resolved by the daemon at Run start;
        // both are surfaced so the display can show "<token> → <resolved>".
        const harnessModel = typeof agent.config.model === "string" ? agent.config.model : null;
        setAgentDefault(pref.model ?? harnessModel);
        const harnessEffort =
          isThinkingEffort(agent.config.thinkingEffort) ||
          agent.config.thinkingEffort === SYMBOLIC_EFFORT_HIGHEST
            ? agent.config.thinkingEffort
            : null;
        setEffortDefault(pref.effort ?? harnessEffort);
        // Backend default: the saved pref, else the harness-authored backend.
        // The Worker gate is daemon-supplied (no hardcoded kernel ids).
        setIsWorker(agent.isWorker);
        const harnessBackend = isAgentBackend(agent.backend) ? agent.backend : null;
        setBackendDefault(pref.backend ?? harnessBackend);
      } catch {
        if (!cancelled) {
          setAgentDefault(null);
          setEffortDefault(null);
          setBackendDefault(null);
          setIsWorker(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiConfig, agentId]);

  // Load the active Thread's conversation-scope pick (ADR-0015 S1) into the
  // in-session pick state, so a per-conversation choice persists across reloads
  // and layers above the agent default. A symbolic stored scope ("latest"/
  // "highest") is left for the daemon resolver — only concrete picks become a
  // per-conversation selection here; a symbolic AGENT default is resolved for
  // display via resolvedDefaultModel/Effort and shown as "<token> → <resolved>".
  useEffect(() => {
    setUserPick(null);
    setEffortPick(null);
    setBackendPick(null);
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const scope = await api.getThreadScope(apiConfig, activeId);
        if (cancelled) return;
        if (typeof scope.model === "string" && scope.model.includes("/")) setUserPick(scope.model);
        if (typeof scope.effort === "string" && isThinkingEffort(scope.effort)) {
          setEffortPick(scope.effort);
        }
        // The stored backend scope is a concrete id; surface it as the
        // in-session pick so the choice survives a reload (ADR-0015).
        if (isAgentBackend(scope.backend)) setBackendPick(scope.backend);
      } catch {
        // Best-effort: a scope read failure just leaves the default selected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiConfig, activeId]);

  // ─── Read-on-select ────────────────────────────────────────────────────
  // Selecting (or re-selecting) a thread marks it read. An explicit "Mark as
  // not read" on the already-active thread must STICK until the user re-selects
  // it, so read fires on a selection CHANGE only — NOT on every `threads`
  // update, which would instantly revert the optimistic unread flip. `markRead`
  // reads the latest threads through a ref so it need not depend on `threads`
  // (which would re-introduce the revert).
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const markRead = useCallback(
    (id: string): void => {
      const cur = threadsRef.current.find((t) => t.id === id);
      if (!cur || (cur.status !== "unread" && cur.status !== "failed")) return;
      setThreads((list) => list.map((t) => (t.id === id ? { ...t, status: "idle" } : t)));
      void api.markThreadRead(apiConfig, id).catch(() => {});
    },
    [apiConfig],
  );
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeId === null) {
      prevActiveRef.current = null;
      return;
    }
    if (prevActiveRef.current === activeId) return; // not a selection change
    prevActiveRef.current = activeId;
    markRead(activeId);
  }, [activeId, markRead]);

  function toggleCollapse(agent: string): void {
    setCollapsed((prev) => {
      const next = { ...prev, [agent]: !prev[agent] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage failures (private mode etc.)
      }
      return next;
    });
  }

  // Patch a single thread from a server-returned summary (archive/title verbs
  // return the updated ThreadSummary — no full refetch needed).
  function patchThread(updated: ThreadSummary): void {
    setThreads((list) => list.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function createThread(agentId: string): Promise<void> {
    const created = await api.createThread(apiConfig, agentId);
    await refreshThreads();
    setActiveId(created.id);
  }

  async function deleteThread(threadId: string): Promise<void> {
    if (!confirm("Delete this thread?")) return;
    await api.deleteThread(apiConfig, threadId);
    setThreads((list) => list.filter((t) => t.id !== threadId));
    if (activeId === threadId) setActiveId(null);
  }

  async function archive(threadId: string): Promise<void> {
    try {
      patchThread(await api.archiveThread(apiConfig, threadId));
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  async function markUnread(threadId: string): Promise<void> {
    // 204 (void) — flip optimistically; the server is the source of truth on
    // the next refetch.
    setThreads((list) =>
      list.map((t) => (t.id === threadId ? { ...t, status: "unread" } : t)),
    );
    try {
      await api.markThreadUnread(apiConfig, threadId);
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    try {
      // setThreadTitle sets titleSource:'manual' server-side; the auto-title
      // pass refuses to overwrite manual, so the rename is sticky.
      patchThread(await api.setThreadTitle(apiConfig, threadId, title));
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  function onMenuAction(threadId: string, action: ThreadMenuAction): void {
    switch (action) {
      case "delete":
        void deleteThread(threadId);
        return;
      case "archive":
        void archive(threadId);
        return;
      case "unread":
        void markUnread(threadId);
        return;
      case "rename":
        setRenamingId(threadId);
        return;
    }
  }

  async function onSelectModel(model: string): Promise<void> {
    setUserPick(model);
    if (!activeId) return;
    // Use-here (ADR-0015 S1): the pick applies to THIS conversation and sticks
    // for its later Runs, WITHOUT touching the agent default. The in-flight
    // message also carries it as modelOverride, so it takes effect immediately.
    // (Apply-to-default is a separate affordance — Lane F C5.)
    try {
      await api.setThreadScope(apiConfig, activeId, { model });
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  async function onSelectEffort(effort: ThinkingEffort): Promise<void> {
    setEffortPick(effort);
    if (!activeId) return;
    // Use-here effort pick (merge — leaves the Thread's model scope untouched).
    // The next message also carries it as effortOverride.
    try {
      await api.setThreadScope(apiConfig, activeId, { effort });
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  async function onSelectBackend(backend: AgentBackend): Promise<void> {
    setBackendPick(backend);
    if (!activeId) return;
    // Use-here backend pick (ADR-0015): applies to THIS conversation and sticks
    // for its later Runs (resolved via the daemon's threadBackend tier), without
    // touching the agent default. Merge — leaves model/effort scope untouched.
    try {
      await api.setThreadScope(apiConfig, activeId, { backend });
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  // Single GENERIC promote helper (P8/P10): writes the picked axis to the agent
  // default and updates the local default state. Generic over the row's concrete
  // value type V, so the row is passed directly with no `as`-cast at the seam.
  // Outcomes land on the established list-error channel — no composer-local
  // status line (P9).
  async function applyToDefault<V extends string>(row: ApplyRow<V>): Promise<void> {
    if (!agentId || row.value === null) return;
    const value = row.value;
    try {
      await row.write(agentId, value);
      row.setDefault(value);
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  // Collapse a generic row to its display view (P10): the apply thunk is bound
  // here, where V is still concrete, so the heterogeneous rows render uniformly
  // without re-widening V or a discriminated union. null-value rows are dropped.
  function makeApplyView<V extends string>(row: ApplyRow<V>): ApplyRowView | null {
    if (!row.enabled || row.value === null) return null;
    return {
      axis: row.axis,
      noun: row.noun,
      value: row.value,
      defaultLabel: row.defaultLabel,
      testId: row.testId,
      onApply: () => void applyToDefault(row),
    };
  }
  const applyViews: ApplyRowView[] = [
    makeApplyView(modelRow),
    makeApplyView(effortRow),
    makeApplyView(backendRow),
  ].filter((v): v is ApplyRowView => v !== null);

  async function onSend(text: string): Promise<void> {
    const content: ContentBlock[] = [{ type: "text", text }];
    await thread.sendMessage(content, selectedModel ?? undefined, effortToSend ?? undefined);
  }

  const inFlight = thread.pending !== null;
  const groups = groupByAgent(threads);
  const activeThread = threads.find((t) => t.id === activeId) ?? null;

  return (
    <>
      <div className="sidebar">
        <div className="thread-list-header">
          <h2>Threads</h2>
          <button
            type="button"
            className="button"
            onClick={() => setShowNewThread(true)}
            data-testid="new-thread"
          >
            New
          </button>
        </div>
        {listError && (
          <div className="banner-error" data-testid="thread-list-error">
            {listError}
          </div>
        )}
        {threads.length === 0 ? (
          <p className="empty">No threads yet.</p>
        ) : (
          <div className="thread-list" data-testid="thread-list">
            {groups.map((group) => {
              const isCollapsed = collapsed[group.agentId] ?? false;
              const page = paginate(group.threads, expandedGroups[group.agentId] ?? false);
              return (
                <section
                  className="thread-group"
                  key={group.agentId}
                  data-testid={`thread-group-${group.agentId}`}
                >
                  <button
                    type="button"
                    className="thread-group-header"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleCollapse(group.agentId)}
                    data-testid={`thread-group-header-${group.agentId}`}
                  >
                    <span className={`group-caret${isCollapsed ? " collapsed" : ""}`} aria-hidden>
                      ▾
                    </span>
                    <span className="thread-group-agent">{group.agentId}</span>
                    <span className="thread-group-count">{group.threads.length}</span>
                  </button>
                  {!isCollapsed && (
                    <ul className="thread-group-list">
                      {page.visible.map((t) => {
                        const meta = statusMeta(t.status);
                        return (
                          <li
                            key={t.id}
                            className={`sidebar-item${activeId === t.id ? " active" : ""}${
                              t.archivedAt !== null ? " archived" : ""
                            }`}
                            role="button"
                            tabIndex={0}
                            aria-current={activeId === t.id}
                            onClick={() => {
                              // Re-selecting the active thread dismisses an
                              // explicit unread; selecting another reads it via
                              // the selection-change effect.
                              if (activeId === t.id) markRead(t.id);
                              else setActiveId(t.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                if (activeId === t.id) markRead(t.id);
                                else setActiveId(t.id);
                              }
                            }}
                            onContextMenu={(e) => {
                              // Don't activate the row: the menu targets
                              // menu.threadId, and activating would trip the
                              // "active thread auto-read" effect — undoing a
                              // subsequent Mark-as-not-read.
                              e.preventDefault();
                              setMenu({ threadId: t.id, x: e.clientX, y: e.clientY });
                            }}
                            data-testid={`thread-${t.id}`}
                          >
                            <div className="thread-row-title">
                              {meta ? (
                                <span
                                  className={`status-dot ${meta.className}`}
                                  role="img"
                                  aria-label={meta.label}
                                  title={meta.label}
                                  data-testid={`status-${t.status}`}
                                />
                              ) : null}
                              {renamingId === t.id && t.id !== activeId ? (
                                <InlineTitle
                                  value={t.title ?? ""}
                                  placeholder={UNTITLED_PLACEHOLDER}
                                  editing={true}
                                  onEditingChange={(ed) => {
                                    if (!ed) setRenamingId(null);
                                  }}
                                  onCommit={(next) => void renameThread(t.id, next)}
                                  className="thread-row-name"
                                  ariaLabel="Rename thread"
                                />
                              ) : (
                                <span className="thread-row-name">{threadTitle(t)}</span>
                              )}
                            </div>
                            <div className="meta">
                              {new Date(t.updatedAt).toLocaleString([], {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </div>
                            <button
                              type="button"
                              className="thread-row-more"
                              aria-label="Conversation actions"
                              title="Conversation actions"
                              data-testid={`thread-more-${t.id}`}
                              onClick={(e) => {
                                // Same menu as right-click, anchored to the button.
                                // Stop the click from selecting the row.
                                e.stopPropagation();
                                const r = e.currentTarget.getBoundingClientRect();
                                setMenu({ threadId: t.id, x: r.left, y: r.bottom });
                              }}
                            >
                              ⋯
                            </button>
                          </li>
                        );
                      })}
                      {page.label !== "none" && (
                        <li className="thread-load-more">
                          <button
                            type="button"
                            className="button ghost small"
                            onClick={() =>
                              setExpandedGroups((prev) => ({ ...prev, [group.agentId]: true }))
                            }
                            data-testid={`load-more-${group.agentId}`}
                          >
                            {page.label === "load-archived" ? "Load archived" : "Load more"}
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <div className="detail chat-main">
        {!activeId ? (
          <div className="empty-state">
            <p className="empty">Select a thread, or start a new one.</p>
          </div>
        ) : (
          <>
            <div className="chat-header">
              <div>
                <h1>
                  <InlineTitle
                    value={activeThread?.title ?? ""}
                    placeholder={UNTITLED_PLACEHOLDER}
                    editing={renamingId === activeId}
                    onEditingChange={(ed) => setRenamingId(ed ? activeId : null)}
                    onCommit={(next) => void renameThread(activeId, next)}
                    className="chat-title"
                    inputClassName="inline-title-input chat-title-input"
                    ariaLabel="Rename thread"
                  />
                </h1>
                <div className="meta-row">
                  {thread.thread?.agentId ?? ""} · thread id: {activeId}
                </div>
              </div>
              <button
                type="button"
                className="button ghost"
                onClick={() => void deleteThread(activeId)}
                data-testid="delete-thread"
              >
                Delete
              </button>
            </div>
            {thread.loadError && (
              <div className="banner-error" data-testid="thread-load-error">
                {thread.loadError}
              </div>
            )}
            <MessageList
              messages={thread.messages}
              pending={thread.pending}
              runError={thread.runError}
            />
            {applyViews.length > 0 && (
              <div className="composer-apply-default-group">
                {applyViews.map((row) => (
                  <ApplyToDefault key={row.axis} row={row} />
                ))}
              </div>
            )}
            <MessageComposer
              inFlight={inFlight}
              onSend={onSend}
              onCancel={() => thread.cancel()}
              models={models}
              selectedModel={selectedModel}
              onSelectModel={(m) => void onSelectModel(m)}
              onAddModels={onNavigateToSecrets}
              efforts={selectedModelEfforts}
              selectedEffort={selectedEffort}
              onSelectEffort={(e) => void onSelectEffort(e)}
              backends={backendOptions}
              selectedBackend={selectedBackend}
              onSelectBackend={(b) => void onSelectBackend(b)}
              showBackendPicker={isWorker}
            />
          </>
        )}
      </div>

      {menu && (
        <ThreadContextMenu
          x={menu.x}
          y={menu.y}
          onAction={(action) => onMenuAction(menu.threadId, action)}
          onClose={() => setMenu(null)}
        />
      )}

      {showNewThread && (
        <NewThreadModal
          apiConfig={apiConfig}
          onClose={() => setShowNewThread(false)}
          onCreate={createThread}
        />
      )}
    </>
  );
}
