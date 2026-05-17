import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ApiConfig, type CapabilityWire } from "../api.ts";

type Kind = CapabilityWire["kind"];

const KIND_LABELS: Record<Kind, string> = {
  skill: "Skills",
  snippet: "Snippets",
  tool: "Tools",
  mcp: "MCP Servers",
};

export function CapabilitiesPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const caps = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api.listCapabilities(apiConfig),
  });
  const agents = useQuery({
    queryKey: ["agents-full"],
    queryFn: async () => {
      const summaries = await api.listAgents(apiConfig);
      return Promise.all(summaries.map((s) => api.getAgent(apiConfig, s.agentId)));
    },
  });

  const [kind, setKind] = useState<Kind>("skill");
  const filtered = (caps.data ?? []).filter((c) => c.kind === kind);

  function whoBinds(name: string, k: Kind): string[] {
    if (!agents.data) return [];
    const field =
      k === "skill" ? "skills" : k === "snippet" ? "snippets" : k === "tool" ? "tools" : "mcp";
    return agents.data
      .filter((a) => a.bindings[field].includes(name))
      .map((a) => a.agentId);
  }

  return (
    <div className="detail" style={{ flex: 1 }}>
      <h1>Capabilities</h1>
      <div className="subtabs">
        {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
          <button
            key={k}
            className={`subtab ${kind === k ? "active" : ""}`}
            onClick={() => setKind(k)}
            data-testid={`cap-tab-${k}`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      {caps.isLoading && <div className="empty">Loading…</div>}
      {kind === "mcp" && filtered.length === 0 && (
        <div className="empty">No MCP servers bundled in this build.</div>
      )}
      {kind === "tool" && (
        <p className="empty">
          Built-in tool registration is not part of this slice. Built-in Tools
          will appear here once they are wired through {""}
          <code>defineTool()</code>.
        </p>
      )}
      {filtered.map((c) => (
        <div key={c.name} className="cap-row" data-testid={`cap-${c.kind}-${c.name}`}>
          <div>
            <div className="name">
              {c.name}
              <span className={`badge badge-${c.layer}`} style={{ marginLeft: 8 }}>
                {c.layer}
              </span>
              <span className={`badge badge-${c.origin}`}>{c.origin}</span>
            </div>
            <div className="desc">{c.description}</div>
            <div className="desc">
              Bound by: {whoBinds(c.name, c.kind).join(", ") || "(no agents)"}
            </div>
            {c.tags && c.tags.length > 0 && (
              <div>
                {c.tags.map((t) => (
                  <span key={t} className="tag-chip">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
