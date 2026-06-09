// ChatPage — top-level layout for chat. Two columns:
//   - Sidebar: thread list grouped by agent (collapsible), paginated,
//     status dots, right-click context menu, live updates via /api/events.
//   - Main: message panel + composer for the selected thread, with an
//     inline-editable header title.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiConfig,
  type AvailableModel,
  type ContentBlock,
  type ThinkingEffort,
  type ThreadSummary,
  api,
  isThinkingEffort,
} from "../api.ts";
import { InlineTitle } from "../components/InlineTitle.tsx";
import { MessageComposer } from "../components/MessageComposer.tsx";
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
  // incompatible stored effort is dropped when the model changes.
  const [effortDefault, setEffortDefault] = useState<ThinkingEffort | null>(null);
  const [effortPick, setEffortPick] = useState<ThinkingEffort | null>(null);

  const selectedModel: string | null =
    userPick ??
    (agentDefault && models.some((m) => m.model === agentDefault)
      ? agentDefault
      : (models[0]?.model ?? agentDefault));

  // The supported effort levels for the currently-selected model (the picker's
  // options). Empty when the selection isn't a known/runnable model.
  const selectedModelEfforts: ThinkingEffort[] =
    models.find((m) => m.model === selectedModel)?.efforts ?? [];

  // Effective effort: the user's in-session pick if still valid for this model,
  // else the agent default if valid, else the model's first supported level —
  // so switching to a model that doesn't support the stored effort never leaves
  // an invalid level selected. null only when the model exposes no efforts.
  const selectedEffort: ThinkingEffort | null =
    (effortPick && selectedModelEfforts.includes(effortPick) ? effortPick : null) ??
    (effortDefault && selectedModelEfforts.includes(effortDefault) ? effortDefault : null) ??
    (selectedModelEfforts[0] ?? null);

  // The composer hides the effort picker for a model whose only level is "off"
  // (no real reasoning choice). Match that here so the send carries no
  // effortOverride for such models — a bare "off" would be a meaningless no-op.
  const hasRealEffort = selectedModelEfforts.some((eff) => eff !== "off");
  const effortToSend: ThinkingEffort | null = hasRealEffort ? selectedEffort : null;

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
    for (const name of ["run.started", "run.completed", "run.failed", "run.cancelled"]) {
      source.addEventListener(name, onRun);
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

  // Load the active agent's stored defaults (saved pref, else harness config),
  // for both model and effort, and clear any prior in-session picks.
  useEffect(() => {
    setUserPick(null);
    setEffortPick(null);
    if (!agentId) {
      setAgentDefault(null);
      setEffortDefault(null);
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
        const harnessModel = typeof agent.config.model === "string" ? agent.config.model : null;
        setAgentDefault(pref.model ?? harnessModel);
        const harnessEffort = isThinkingEffort(agent.config.thinkingEffort)
          ? agent.config.thinkingEffort
          : null;
        setEffortDefault(pref.effort ?? harnessEffort);
      } catch {
        if (!cancelled) {
          setAgentDefault(null);
          setEffortDefault(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiConfig, agentId]);

  // ─── Mark active thread read ───────────────────────────────────────────
  // Whenever the active thread is in an unread/failed state while being viewed,
  // clear it. This covers both (a) opening an unread thread and (b) a
  // run.completed/failed envelope reintroducing unread for the already-active
  // thread (the live refetch surfaces the new status; this re-clears it).
  // Optimistic local flip + the server POST /read; the EventSource backstops.
  // The setState guard makes the flip idempotent, so no extra POST fires for a
  // thread already shown as idle.
  useEffect(() => {
    if (!activeId) return;
    const cur = threads.find((t) => t.id === activeId);
    if (!cur || (cur.status !== "unread" && cur.status !== "failed")) return;
    setThreads((list) =>
      list.map((t) => (t.id === activeId ? { ...t, status: "idle" } : t)),
    );
    void api.markThreadRead(apiConfig, activeId).catch(() => {});
  }, [threads, activeId, apiConfig]);

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
    if (!agentId) return;
    // Persist as the agent's sticky default. The in-flight message also carries
    // it as modelOverride, so the choice takes effect immediately.
    try {
      await api.setAgentModelPref(apiConfig, agentId, { model });
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  async function onSelectEffort(effort: ThinkingEffort): Promise<void> {
    setEffortPick(effort);
    if (!agentId) return;
    // Persist as the agent's sticky effort default (merge — leaves the model
    // pref untouched). The next message also carries it as effortOverride.
    try {
      await api.setAgentModelPref(apiConfig, agentId, { effort });
    } catch (err) {
      setListError((err as Error).message);
    }
  }

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
                            onClick={() => setActiveId(t.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setActiveId(t.id);
                              }
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setActiveId(t.id);
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
                              {renamingId === t.id ? (
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
