// ChatPage — top-level layout for chat. Two columns:
//   - Sidebar: thread list + New Thread button.
//   - Main: message panel + composer for the selected thread.

import { useCallback, useEffect, useState } from "react";
import { type ApiConfig, type ContentBlock, type ThreadSummary, api } from "../api.ts";
import { MessageComposer } from "../components/MessageComposer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { NewThreadModal } from "../components/NewThreadModal.tsx";
import { useChatThread } from "../hooks/useChatThread.ts";

export function ChatPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

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
    await thread.sendMessage(content);
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
            <MessageComposer inFlight={inFlight} onSend={onSend} onCancel={() => thread.cancel()} />
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
