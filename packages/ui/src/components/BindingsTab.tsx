import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type AgentDetail, type ApiConfig, api, type CapabilityWire } from "../api.ts";
import {
  applyFilter,
  capabilitySource,
  capabilityWorkspace,
  EMPTY_FILTER,
  extractFacets,
  type FilterState,
  type GroupKey,
  groupCapabilities,
  isFilterActive,
  workspaceLabel,
} from "../capability-filters.ts";
import { type BindingKind } from "../editing-session.ts";
import { useAgentEditor } from "../hooks/useAgentEditor.ts";
import { CapabilityFilterBar } from "./CapabilityFilterBar.tsx";

const KIND_LABELS: Record<BindingKind, string> = {
  skill: "Skills",
  snippet: "Snippets",
  tool: "Tools",
  mcp: "MCP Servers",
};

const KIND_NOTES: Partial<Record<BindingKind, string>> = {
  snippet:
    "Snippets are consumed by the Agent Manager at agent-authoring time, not by this agent at runtime.",
};

const KIND_ORDER: BindingKind[] = ["skill", "snippet", "tool", "mcp"];

export function BindingsTab({
  apiConfig,
  agent,
}: {
  apiConfig: ApiConfig;
  agent: AgentDetail;
}): JSX.Element {
  const caps = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api.listCapabilities(apiConfig),
  });

  const editor = useAgentEditor(apiConfig, agent);
  const [kind, setKind] = useState<BindingKind>("skill");
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [groupBy, setGroupBy] = useState<GroupKey>("none");
  // Collapsed groups within the current kind. Labels are unique within a
  // (kind, groupBy) pair; reset whenever either changes so collapse state
  // never points at stale labels.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: groupBy/kind are the reset triggers, not read in the body
  useEffect(() => setCollapsed(new Set()), [groupBy, kind]);

  function toggleCollapsed(key: string): void {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  }

  // Kind-scoped filter: a tag/source/workspace selection valid on one kind
  // is usually irrelevant on another. Switching kinds resets the filter to
  // avoid the silent dead-end UX where an invisible chip continues to AND.
  function selectKind(next: BindingKind): void {
    if (next === kind) return;
    setKind(next);
    setFilter(EMPTY_FILTER);
  }

  // Build the per-kind universe. Tools have no on-disk Capability entries
  // today, so we synthesize placeholder entries for currently-bound names
  // so the user can at least unbind them.
  const universes = useMemo(() => {
    const real = caps.data ?? [];
    const skill = real.filter((c) => c.kind === "skill");
    const snippet = real.filter((c) => c.kind === "snippet");
    const mcp = real.filter((c) => c.kind === "mcp");
    const toolNames = Array.from(new Set([...agent.bindings.tools, ...editor.selected.tool]));
    const tool: CapabilityWire[] = toolNames.map((name) => ({
      name,
      kind: "tool",
      description: "(built-in tool)",
      origin: "personal",
      layer: "bundled",
      discovery: "builtin",
    }));
    return { skill, snippet, tool, mcp };
  }, [caps.data, agent.bindings.tools, editor.selected.tool]);

  const kindUniverse = universes[kind];
  const facets = useMemo(() => extractFacets(kindUniverse), [kindUniverse]);
  const filtered = useMemo(() => applyFilter(kindUniverse, filter), [kindUniverse, filter]);
  const grouped = useMemo(() => groupCapabilities(filtered, groupBy), [filtered, groupBy]);

  const filterActive = isFilterActive(filter);

  // Bound count per kind shown in the kind tab labels for at-a-glance state.
  const boundCounts: Record<BindingKind, number> = {
    skill: editor.selected.skill.size,
    snippet: editor.selected.snippet.size,
    tool: editor.selected.tool.size,
    mcp: editor.selected.mcp.size,
  };

  const note = KIND_NOTES[kind];

  return (
    <>
      <div className="subtabs">
        {KIND_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            className={`subtab ${kind === k ? "active" : ""}`}
            onClick={() => selectKind(k)}
            data-testid={`bind-tab-${k}`}
          >
            {KIND_LABELS[k]}
            <span className="empty" style={{ marginLeft: 6 }}>
              ({boundCounts[k]})
            </span>
          </button>
        ))}
      </div>

      {note && <p className="empty">{note}</p>}

      {kindUniverse.length > 0 && (
        <CapabilityFilterBar
          testIdPrefix="bind"
          facets={facets}
          filter={filter}
          setFilter={setFilter}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
          filterActive={filterActive}
          onClear={() => setFilter(EMPTY_FILTER)}
          count={{ total: kindUniverse.length, shown: filtered.length }}
        />
      )}

      {kind === "mcp" && kindUniverse.length === 0 && (
        <div className="empty">No MCP servers bundled in this build.</div>
      )}

      {kindUniverse.length > 0 && filtered.length === 0 && (
        <div className="empty">No matches for the current filter.</div>
      )}

      {grouped.map((group) => {
        const key = group.label || "all";
        const isCollapsed = collapsed.has(key);
        return (
          <div key={key}>
            {groupBy !== "none" && (
              // biome-ignore lint/a11y/useSemanticElements: row-styled collapse toggle; a native <button> can't carry the group-header grid layout
              <div
                className="binding-group-header group-header"
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                onClick={() => toggleCollapsed(key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleCollapsed(key);
                  }
                }}
                data-testid={`bind-group-${group.label}`}
              >
                <span className="group-caret">{isCollapsed ? "▸" : "▾"}</span> {group.label}{" "}
                <span className="empty">({group.items.length})</span>
              </div>
            )}
            {!isCollapsed &&
              group.items.map((c) => (
                <CapabilityCheckbox
                  key={c.name}
                  cap={c}
                  kind={kind}
                  checked={editor.selected[kind].has(c.name)}
                  onToggle={() => editor.toggle(kind, c.name)}
                />
              ))}
          </div>
        );
      })}

      <div className="section">
        <button
          type="button"
          className="button ghost"
          onClick={editor.reset}
          disabled={!agent.hasFork || editor.isResetting}
          data-testid="reset-button"
        >
          Reset to bundled defaults
        </button>
      </div>

      {editor.hasPending && (
        <div className="pending">
          <div className="changes">
            <strong>
              {editor.pending.length} pending change{editor.pending.length === 1 ? "" : "s"}
            </strong>
            <ul data-testid="pending-list">
              {editor.pending.map((p) => (
                <li key={`${p.kind}-${p.name}-${p.action}`}>
                  {p.action} {p.kind}: <code>{p.name}</code>
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            className="button ghost"
            onClick={editor.discard}
            disabled={editor.isSaving}
          >
            Discard
          </button>
          <button
            type="button"
            className="button"
            onClick={editor.save}
            disabled={editor.isSaving}
            data-testid="save-button"
          >
            {editor.isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </>
  );
}

function CapabilityCheckbox({
  cap,
  kind,
  checked,
  onToggle,
}: {
  cap: CapabilityWire;
  kind: BindingKind;
  checked: boolean;
  onToggle: () => void;
}): JSX.Element {
  const src = capabilitySource(cap);
  return (
    <label className="cap-row" data-testid={`bind-${kind}-${cap.name}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div>
        <div className="name">
          {cap.name}
          <span className={`badge badge-${cap.layer}`} style={{ marginLeft: 8 }}>
            {cap.layer}
          </span>
          <span className={`badge badge-${cap.origin}`}>
            {workspaceLabel(capabilityWorkspace(cap))}
          </span>
          {src.kind === "upstream" && <span className="badge badge-source">{src.slug}</span>}
        </div>
        <div className="desc">{cap.description}</div>
      </div>
    </label>
  );
}
