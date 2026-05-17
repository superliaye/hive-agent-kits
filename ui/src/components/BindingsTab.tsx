import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type AgentDetail, type ApiConfig, type CapabilityWire } from "../api.ts";
import {
  type BindingKind,
  computePending,
  initialSelected,
  togglePresent,
} from "../pending.ts";

const KIND_LABELS: Record<BindingKind, string> = {
  skill: "Skills",
  snippet: "Snippets",
  tool: "Tools",
  mcp: "MCP Servers",
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

  // Reset local selection whenever the persisted bindings change.
  const baseline = useMemo(() => initialSelected(agent), [agent]);
  const [selected, setSelected] = useState(baseline);
  const [resetKey, setResetKey] = useState(agent.agentId);
  if (resetKey !== agent.agentId) {
    setResetKey(agent.agentId);
    setSelected(baseline);
  }

  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: async () => {
      const patches = computePending(agent, selected);
      let last = agent;
      for (const p of patches) {
        last = await api.patchBindings(apiConfig, agent.agentId, p);
      }
      return last;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agents", agent.agentId] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.resetAgent(apiConfig, agent.agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agents", agent.agentId] });
    },
  });

  const pending = computePending(agent, selected);
  const hasPending = pending.length > 0;

  function toggle(kind: BindingKind, name: string): void {
    setSelected((prev) => ({
      ...prev,
      [kind]: togglePresent(prev[kind], name),
    }));
  }

  function discard(): void {
    setSelected(baseline);
  }

  return (
    <>
      <BindingSection
        kind="skill"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={selected.skill}
        onToggle={(name) => toggle("skill", name)}
      />
      <BindingSection
        kind="snippet"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={selected.snippet}
        onToggle={(name) => toggle("snippet", name)}
        note="Snippets are consumed by the Agent Manager at agent-authoring time, not by this agent at runtime."
      />
      <BindingSection
        kind="tool"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={selected.tool}
        onToggle={(name) => toggle("tool", name)}
      />
      <BindingSection
        kind="mcp"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={selected.mcp}
        onToggle={(name) => toggle("mcp", name)}
      />

      <div className="section">
        <button
          className="button ghost"
          onClick={() => resetMutation.mutate()}
          disabled={!agent.hasFork || resetMutation.isPending}
          data-testid="reset-button"
        >
          Reset to bundled defaults
        </button>
      </div>

      {hasPending && (
        <div className="pending">
          <div className="changes">
            <strong>{pending.length} pending change{pending.length === 1 ? "" : "s"}</strong>
            <ul data-testid="pending-list">
              {pending.map((p) => (
                <li key={`${p.kind}-${p.name}-${p.action}`}>
                  {p.action} {p.kind}: <code>{p.name}</code>
                </li>
              ))}
            </ul>
          </div>
          <button className="button ghost" onClick={discard} disabled={patch.isPending}>
            Discard
          </button>
          <button
            className="button"
            onClick={() => patch.mutate()}
            disabled={patch.isPending}
            data-testid="save-button"
          >
            {patch.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </>
  );
}

function BindingSection({
  kind,
  agent,
  capabilities,
  selected,
  onToggle,
  note,
}: {
  kind: BindingKind;
  agent: AgentDetail;
  capabilities: CapabilityWire[];
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
  note?: string;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  // For "tool" kind there are no on-disk Capability entries today. Show the
  // names that are currently bound to this agent so the user can at least
  // unbind them — pragmatic until built-in tools are registered.
  const universe = useMemo(() => {
    if (kind === "tool") {
      const names = Array.from(new Set([...agent.bindings.tools, ...selected]));
      return names.map<CapabilityWire>((name) => ({
        name,
        kind: "tool",
        description: "(built-in tool)",
        origin: "personal",
        layer: "bundled",
        source: "builtin",
      }));
    }
    return capabilities.filter((c) => c.kind === kind);
  }, [kind, capabilities, agent.bindings.tools, selected]);

  const tags = useMemo(() => {
    const all = new Set<string>();
    for (const c of universe) for (const t of c.tags ?? []) all.add(t);
    return Array.from(all).sort();
  }, [universe]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return universe.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !c.description.toLowerCase().includes(q)) {
        return false;
      }
      if (activeTags.size > 0 && !(c.tags ?? []).some((t) => activeTags.has(t))) {
        return false;
      }
      return true;
    });
  }, [universe, search, activeTags]);

  function toggleTag(t: string): void {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <section className="section">
      <h3>{KIND_LABELS[kind]}</h3>
      {note && <p className="empty">{note}</p>}
      <div className="search-row">
        <input
          placeholder={`Search ${KIND_LABELS[kind].toLowerCase()}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {tags.length > 0 && (
        <div>
          {tags.map((t) => (
            <span
              key={t}
              className={`tag-chip ${activeTags.has(t) ? "active" : ""}`}
              onClick={() => toggleTag(t)}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {filtered.length === 0 && <div className="empty">No matches.</div>}
      {filtered.map((c) => (
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
              <span className={`badge badge-${c.origin}`}>{c.origin}</span>
            </div>
            <div className="desc">{c.description}</div>
          </div>
        </label>
      ))}
    </section>
  );
}
