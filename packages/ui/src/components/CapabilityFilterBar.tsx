// Filter UI shared by the Capabilities page and the BindingsTab. Pure
// presentation — all filter math lives in capability-filters.ts. Callers
// supply the facets (already extracted), the current FilterState, the
// group-by selection, and a testIdPrefix so e2e selectors stay distinct.

import type { FilterState, GroupKey, SourceFacet, Workspace } from "../capability-filters.ts";
import {
  type FilterAxis,
  sourceKey,
  sourceLabel,
  toggleFilterValue,
  workspaceKey,
  workspaceLabel,
} from "../capability-filters.ts";

export type CapabilityFilterBarProps = {
  testIdPrefix: "cap" | "bind";
  facets: {
    tags: string[];
    workspaces: Workspace[];
    sources: SourceFacet[];
  };
  filter: FilterState;
  setFilter: (next: FilterState) => void;
  groupBy: GroupKey;
  setGroupBy: (next: GroupKey) => void;
  filterActive: boolean;
  onClear: () => void;
  // Count summary in the top-right. Pass `undefined` to hide.
  count?: { total: number; shown: number };
  searchPlaceholder?: string;
};

export function CapabilityFilterBar({
  testIdPrefix,
  facets,
  filter,
  setFilter,
  groupBy,
  setGroupBy,
  filterActive,
  onClear,
  count,
  searchPlaceholder = "Search name or description…",
}: CapabilityFilterBarProps): JSX.Element {
  function toggle(axis: FilterAxis, value: string): void {
    setFilter(toggleFilterValue(filter, axis, value));
  }

  return (
    <div className="filter-bar">
      <div className="filter-row">
        <input
          className="filter-search"
          placeholder={searchPlaceholder}
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          data-testid={`${testIdPrefix}-search`}
        />
        <label className="group-by">
          Group by:&nbsp;
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupKey)}
            data-testid={`${testIdPrefix}-group-by`}
          >
            <option value="none">None</option>
            <option value="source">Source</option>
            <option value="tag">Tag</option>
            <option value="workspace">Workspace</option>
          </select>
        </label>
        {count && (
          <span className="filter-count">
            {filterActive ? `${count.shown} / ${count.total}` : `${count.total} total`}
          </span>
        )}
        {filterActive && (
          <button
            type="button"
            className="button ghost"
            onClick={onClear}
            data-testid={`${testIdPrefix}-filter-clear`}
          >
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
              onToggle={() => toggle("tags", t)}
              testId={`${testIdPrefix}-chip-tag-${t}`}
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
                onToggle={() => toggle("workspaces", k)}
                testId={`${testIdPrefix}-chip-workspace-${k}`}
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
                onToggle={() => toggle("sources", k)}
                testId={`${testIdPrefix}-chip-source-${k}`}
              />
            );
          })}
        </FacetRow>
      )}
    </div>
  );
}

function FacetRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
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
  testId,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`tag-chip ${active ? "active" : ""}`}
      aria-pressed={active}
      onClick={onToggle}
      data-testid={testId}
    >
      {label}
    </button>
  );
}
