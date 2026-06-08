// ChatPage — top-level layout for chat. Two columns:
//   - Sidebar: thread list + New Thread button.
//   - Main: message panel + composer for the selected thread.

import { useCallback, useEffect, useState } from "react";
import {
  type ApiConfig,
  type AvailableModel,
  type ContentBlock,
  type ThinkingEffort,
  type ThreadSummary,
  api,
  isThinkingEffort,
} from "../api.ts";
import { MessageComposer } from "../components/MessageComposer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { NewThreadModal } from "../components/NewThreadModal.tsx";
import { useChatThread } from "../hooks/useChatThread.ts";

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

  const refreshThreads = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listThreads(apiConfig);
      setThreads(list);
      setListError(null);
      // Auto-select first thread if none selected and threads exist.
      if (list.length > 0 && activeId === null) {
        setActiveId(list[0]?.id ?? null);
      } else if (activeId && !list.find((t) => t.id === activeId)) {
        // Selected thread was deleted externally; pick a new one or clear.
        setActiveId(list[0]?.id ?? null);
      }
    } catch (err) {
      setListError((err as Error).message);
    }
  }, [apiConfig, activeId]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const thread = useChatThread(apiConfig, activeId);
  const agentId = thread.thread?.agentId ?? null;

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

  async function createThread(agentId: string): Promise<void> {
    const created = await api.createThread(apiConfig, agentId);
    await refreshThreads();
    setActiveId(created.id);
  }

  async function deleteActive(): Promise<void> {
    if (!activeId) return;
    if (!confirm("Delete this thread?")) return;
    await api.deleteThread(apiConfig, activeId);
    setActiveId(null);
    await refreshThreads();
  }

  async function onSend(text: string): Promise<void> {
    const content: ContentBlock[] = [{ type: "text", text }];
    await thread.sendMessage(content, selectedModel ?? undefined, effortToSend ?? undefined);
  }

  const inFlight = thread.pending !== null;

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
          <ul className="thread-list" data-testid="thread-list">
            {threads.map((t) => (
              <li
                key={t.id}
                className={`sidebar-item${activeId === t.id ? " active" : ""}`}
                onClick={() => setActiveId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveId(t.id);
                  }
                }}
                data-testid={`thread-${t.id}`}
              >
                <div className="thread-list-agent">{t.agentId}</div>
                <div className="meta">
                  {new Date(t.updatedAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </li>
            ))}
          </ul>
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
                <h1>{thread.thread?.agentId ?? activeId}</h1>
                <div className="meta-row">thread id: {activeId}</div>
              </div>
              <button
                type="button"
                className="button ghost"
                onClick={() => void deleteActive()}
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
