import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type AgentDetail, type ApiConfig, type CapabilityWire } from "../api.ts";
import {
  applyFilter,
  capabilitySource,
  capabilityWorkspace,
  EMPTY_FILTER,
  extractFacets,
  type FilterState,
  groupCapabilities,
  type GroupKey,
  sourceKey,
  sourceLabel,
  workspaceKey,
  workspaceLabel,
} from "../capability-filters.ts";
import { type BindingKind } from "../editing-session.ts";
import { useAgentEditor } from "../hooks/useAgentEditor.ts";

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
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [groupBy, setGroupBy] = useState<GroupKey>("none");

  // Build the per-kind universe. Tools have no on-disk Capability entries
  // today, so we synthesize placeholder entries for currently-bound names
  // so the user can at least unbind them.
  const universes = useMemo(() => {
    const real = caps.data ?? [];
    const skill = real.filter((c) => c.kind === "skill");
    const snippet = real.filter((c) => c.kind === "snippet");
    const mcp = real.filter((c) => c.kind === "mcp");
    const toolNames = Array.from(
      new Set([...agent.bindings.tools, ...editor.selected.tool]),
    );
    const tool: CapabilityWire[] = toolNames.map((name) => ({
      name,
      kind: "tool",
      description: "(built-in tool)",
      origin: "personal",
      layer: "bundled",
      source: "builtin",
    }));
    return { skill, snippet, tool, mcp };
  }, [caps.data, agent.bindings.tools, editor.selected.tool]);

  // Combine all four universes for facet extraction — the chip bar reflects
  // every value present across all sections so the user can filter from one place.
  const allCaps = useMemo(
    () => [...universes.skill, ...universes.snippet, ...universes.tool, ...universes.mcp],
    [universes],
  );
  const facets = useMemo(() => extractFacets(allCaps), [allCaps]);

  function toggleAxis(axis: "tags" | "workspaces" | "sources", value: string): void {
    const set = new Set(filter[axis]);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    setFilter({ ...filter, [axis]: set });
  }

  const filterActive =
    filter.search.length > 0 ||
    filter.tags.size > 0 ||
    filter.workspaces.size > 0 ||
    filter.sources.size > 0;

  return (
    <>
      <FilterBar
        facets={facets}
        filter={filter}
        setFilter={setFilter}
        toggleAxis={toggleAxis}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        filterActive={filterActive}
        onClear={() => setFilter(EMPTY_FILTER)}
      />

      {(["skill", "snippet", "tool", "mcp"] as BindingKind[]).map((kind) => (
        <BindingSection
          key={kind}
          kind={kind}
          universe={universes[kind]}
          filter={filter}
          groupBy={groupBy}
          selected={editor.selected[kind]}
          onToggle={(name) => editor.toggle(kind, name)}
        />
      ))}

      <div className="section">
        <button
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
          <button className="button ghost" onClick={editor.discard} disabled={editor.isSaving}>
            Discard
          </button>
          <button
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

function FilterBar({
  facets,
  filter,
  setFilter,
  toggleAxis,
  groupBy,
  setGroupBy,
  filterActive,
  onClear,
}: {
  facets: ReturnType<typeof extractFacets>;
  filter: FilterState;
  setFilter: (next: FilterState) => void;
  toggleAxis: (axis: "tags" | "workspaces" | "sources", value: string) => void;
  groupBy: GroupKey;
  setGroupBy: (next: GroupKey) => void;
  filterActive: boolean;
  onClear: () => void;
}): JSX.Element {
  return (
    <div className="filter-bar">
      <div className="filter-row">
        <input
          className="filter-search"
          placeholder="Search bindings (name or description)…"
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          data-testid="bind-search"
        />
        <label className="group-by">
          Group by:&nbsp;
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupKey)}
            data-testid="bind-group-by"
          >
            <option value="none">None</option>
            <option value="source">Source</option>
            <option value="tag">Tag</option>
            <option value="workspace">Workspace</option>
          </select>
        </label>
        {filterActive && (
          <button className="button ghost" onClick={onClear} data-testid="bind-filter-clear">
            Clear
          </button>
        )}
      </div>

      {facets.tags.length > 0 && (
        <FacetRow label="Tags">
          {facets.tags.map((t) => (
            <ChipFilter
              key={t}
              label={t}
              active={filter.tags.has(t)}
              onToggle={() => toggleAxis("tags", t)}
            />
          ))}
        </FacetRow>
      )}

      {facets.workspaces.length > 1 && (
        <FacetRow label="Workspace">
          {facets.workspaces.map((w) => {
            const k = workspaceKey(w);
            return (
              <ChipFilter
                key={k}
                label={workspaceLabel(w)}
                active={filter.workspaces.has(k)}
                onToggle={() => toggleAxis("workspaces", k)}
              />
            );
          })}
        </FacetRow>
      )}

      {facets.sources.length > 1 && (
        <FacetRow label="Source">
          {facets.sources.map((s) => {
            const k = sourceKey(s);
            return (
              <ChipFilter
                key={k}
                label={sourceLabel(s)}
                active={filter.sources.has(k)}
                onToggle={() => toggleAxis("sources", k)}
              />
            );
          })}
        </FacetRow>
      )}
    </div>
  );
}

function FacetRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="facet-row">
      <span className="facet-label">{label}:</span>
      <div className="facet-chips">{children}</div>
    </div>
  );
}

function ChipFilter({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <span
      className={`tag-chip ${active ? "active" : ""}`}
      onClick={onToggle}
    >
      {label}
    </span>
  );
}

function BindingSection({
  kind,
  universe,
  filter,
  groupBy,
  selected,
  onToggle,
}: {
  kind: BindingKind;
  universe: CapabilityWire[];
  filter: FilterState;
  groupBy: GroupKey;
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
}): JSX.Element {
  const filtered = useMemo(() => applyFilter(universe, filter), [universe, filter]);
  const grouped = useMemo(
    () => groupCapabilities(filtered, groupBy),
    [filtered, groupBy],
  );
  const note = KIND_NOTES[kind];
  const selectedCount = Array.from(selected).filter((name) =>
    universe.some((c) => c.name === name),
  ).length;

  return (
    <section className="section">
      <h3>
        {KIND_LABELS[kind]}{" "}
        <span className="empty">
          ({selectedCount} bound{filter.search || filter.tags.size > 0 ? `, ${filtered.length} shown` : ""})
        </span>
      </h3>
      {note && <p className="empty">{note}</p>}
      {filtered.length === 0 && <div className="empty">No matches.</div>}
      {grouped.map((group) => (
        <div key={group.label || "all"}>
          {groupBy !== "none" && (
            <div className="binding-group-header">
              {group.label} <span className="empty">({group.items.length})</span>
            </div>
          )}
          {group.items.map((c) => (
            <label key={c.name} className="cap-row" data-testid={`bind-${kind}-${c.name}`}>
              <input
                type="checkbox"
                checked={selected.has(c.name)}
                onChange={() => onToggle(c.name)}
              />
              <div>
                <div className="name">
                  {c.name}
                  <span className={`badge badge-${c.layer}`} style={{ marginLeft: 8 }}>
                    {c.layer}
                  </span>
                  <span className={`badge badge-${c.origin}`}>
                    {workspaceLabel(capabilityWorkspace(c))}
                  </span>
                  {capabilitySource(c).kind === "upstream" && (
                    <span className="badge badge-source">
                      {(capabilitySource(c) as { kind: "upstream"; slug: string }).slug}
                    </span>
                  )}
                </div>
                <div className="desc">{c.description}</div>
              </div>
            </label>
          ))}
        </div>
      ))}
    </section>
  );
}
