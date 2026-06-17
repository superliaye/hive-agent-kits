import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiConfig, api } from "../api.ts";
import { AgentDetail } from "../components/AgentDetail.tsx";

export function AgentsPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(apiConfig),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = agents.data ?? [];
  const activeId = selectedId ?? list[0]?.agentId ?? null;

  return (
    <>
      <div className="sidebar">
        <h2>Agents</h2>
        {agents.isLoading && <div className="empty">Loading…</div>}
        {agents.isError && <div className="empty">Failed: {String(agents.error)}</div>}
        {list.map((a) => (
          // biome-ignore lint/a11y/useSemanticElements: sidebar row presents as a list entry but acts as a selectable button
          <div
            key={a.agentId}
            className={`sidebar-item ${activeId === a.agentId ? "active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={activeId === a.agentId}
            onClick={() => setSelectedId(a.agentId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelectedId(a.agentId);
              }
            }}
            data-testid={`agent-${a.agentId}`}
          >
            <div>{a.agentId}</div>
            <div className="meta">
              {a.domain} · {a.layer}
              {a.hasFork ? " · fork" : ""}
            </div>
          </div>
        ))}
      </div>
      {activeId ? (
        <AgentDetail apiConfig={apiConfig} agentId={activeId} />
      ) : (
        <div className="detail empty">Select an agent.</div>
      )}
    </>
  );
}
