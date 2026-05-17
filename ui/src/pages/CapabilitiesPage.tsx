import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type ApiConfig, type CapabilityWire } from "../api.ts";
import {
  applyFilter,
  capabilitySource,
  capabilityWorkspace,
  EMPTY_FILTER,
  extractFacets,
  type FilterState,
  groupCapabilities,
  type GroupKey,
  isFilterActive,
  workspaceLabel,
} from "../capability-filters.ts";
import { CapabilityFilterBar } from "../components/CapabilityFilterBar.tsx";

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
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [groupBy, setGroupBy] = useState<GroupKey>("none");

  const kindCaps = useMemo(
    () => (caps.data ?? []).filter((c) => c.kind === kind),
    [caps.data, kind],
  );
  const facets = useMemo(() => extractFacets(kindCaps), [kindCaps]);
  const filtered = useMemo(() => applyFilter(kindCaps, filter), [kindCaps, filter]);
  const grouped = useMemo(() => groupCapabilities(filtered, groupBy), [filtered, groupBy]);

  const whoBinds = (name: string, k: Kind): string[] => {
    if (!agents.data) return [];
    const field = k === "skill" ? "skills" : k === "snippet" ? "snippets" : k === "tool" ? "tools" : "mcp";
    return agents.data.filter((a) => a.bindings[field].includes(name)).map((a) => a.agentId);
  };

  const filterActive = isFilterActive(filter);

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

      {kind === "tool" && (
        <p className="empty">
          Built-in tool registration is not part of this slice. Built-in Tools will appear
          here once they are wired through <code>defineTool()</code>.
        </p>
      )}

      {kindCaps.length > 0 && (
        <CapabilityFilterBar
          testIdPrefix="cap"
          facets={facets}
          filter={filter}
          setFilter={setFilter}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
          filterActive={filterActive}
          onClear={() => setFilter(EMPTY_FILTER)}
          count={{ total: kindCaps.length, shown: filtered.length }}
        />
      )}

      {kind === "mcp" && kindCaps.length === 0 && (
        <div className="empty">No MCP servers bundled in this build.</div>
      )}

      {grouped.map((group) => (
        <CapabilityGroup
          key={group.label || "all"}
          group={group}
          showHeader={groupBy !== "none"}
          whoBinds={whoBinds}
        />
      ))}

      {filterActive && filtered.length === 0 && (
        <div className="empty">No capabilities match the current filter.</div>
      )}
    </div>
  );
}

function CapabilityGroup({
  group,
  showHeader,
  whoBinds,
}: {
  group: { label: string; items: CapabilityWire[] };
  showHeader: boolean;
  whoBinds: (name: string, kind: Kind) => string[];
}): JSX.Element {
  return (
    <section className="section">
      {showHeader && (
        <h3>
          {group.label} <span className="empty">({group.items.length})</span>
        </h3>
      )}
      {group.items.map((c) => (
        <CapabilityRow key={c.name} cap={c} boundBy={whoBinds(c.name, c.kind)} />
      ))}
    </section>
  );
}

function CapabilityRow({
  cap,
  boundBy,
}: {
  cap: CapabilityWire;
  boundBy: string[];
}): JSX.Element {
  const ws = capabilityWorkspace(cap);
  const src = capabilitySource(cap);
  return (
    <div className="cap-row" data-testid={`cap-${cap.kind}-${cap.name}`}>
      <div>
        <div className="name">
          {cap.name}
          <span className={`badge badge-${cap.layer}`} style={{ marginLeft: 8 }}>
            {cap.layer}
          </span>
          <span className={`badge badge-${cap.origin}`}>{workspaceLabel(ws)}</span>
          {src.kind === "upstream" && (
            <span className="badge badge-source">{src.slug}</span>
          )}
        </div>
        <div className="desc">{cap.description}</div>
        <div className="desc">
          Bound by: {boundBy.join(", ") || "(no agents)"}
        </div>
        {cap.tags && cap.tags.length > 0 && (
          <div>
            {cap.tags.map((t) => (
              <span key={t} className="tag-chip">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
