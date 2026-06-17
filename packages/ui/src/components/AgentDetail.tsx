import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiConfig, api } from "../api.ts";
import { BindingsTab } from "./BindingsTab.tsx";

type SubTab = "prompt" | "bindings" | "config" | "memory";

export function AgentDetail({
  apiConfig,
  agentId,
}: {
  apiConfig: ApiConfig;
  agentId: string;
}): JSX.Element {
  const detail = useQuery({
    queryKey: ["agents", agentId],
    queryFn: () => api.getAgent(apiConfig, agentId),
  });
  const [tab, setTab] = useState<SubTab>("bindings");

  if (detail.isLoading) return <div className="detail empty">Loading…</div>;
  if (detail.isError) return <div className="detail empty">Failed: {String(detail.error)}</div>;
  const agent = detail.data;
  if (!agent) return <div className="detail empty">Not found.</div>;

  return (
    <div className="detail">
      <h1>{agent.agentId}</h1>
      <div className="meta-row">
        {agent.domain} · {agent.backend} · {agent.layer}
        {agent.hasFork ? " · fork" : ""}
      </div>
      {agent.forkError && (
        <div className="banner-error" data-testid="fork-error-banner">
          <strong>Runtime fork failed to load.</strong> Showing the bundled fallback; your edits to
          this Agent's runtime HARNESS.md are being ignored until the parse error is fixed:
          <pre className="banner-detail">{agent.forkError}</pre>
        </div>
      )}
      <div className="subtabs">
        <button
          type="button"
          className={`subtab ${tab === "prompt" ? "active" : ""}`}
          onClick={() => setTab("prompt")}
          data-testid="subtab-prompt"
        >
          Prompt
        </button>
        <button
          type="button"
          className={`subtab ${tab === "bindings" ? "active" : ""}`}
          onClick={() => setTab("bindings")}
          data-testid="subtab-bindings"
        >
          Bindings
        </button>
        <button
          type="button"
          className={`subtab ${tab === "config" ? "active" : ""}`}
          onClick={() => setTab("config")}
          data-testid="subtab-config"
        >
          Model & Config
        </button>
        <button
          type="button"
          className={`subtab ${tab === "memory" ? "active" : ""}`}
          onClick={() => setTab("memory")}
          data-testid="subtab-memory"
        >
          Memory
        </button>
      </div>
      {tab === "prompt" && <pre className="config">{agent.promptBody}</pre>}
      {tab === "bindings" && <BindingsTab apiConfig={apiConfig} agent={agent} />}
      {tab === "config" && (
        <>
          <p className="empty">Read-only. Editing requires an Agent Manager Run.</p>
          <pre className="config">{JSON.stringify(agent.config, null, 2)}</pre>
        </>
      )}
      {tab === "memory" && <p className="empty">Memory module not yet implemented.</p>}
    </div>
  );
}
