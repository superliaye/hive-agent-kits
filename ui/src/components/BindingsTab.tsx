import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type AgentDetail, type ApiConfig, type CapabilityWire } from "../api.ts";
import { type BindingKind } from "../editing-session.ts";
import { useAgentEditor } from "../hooks/useAgentEditor.ts";

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

  const editor = useAgentEditor(apiConfig, agent);

  return (
    <>
      <BindingSection
        kind="skill"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={editor.selected.skill}
        onToggle={(name) => editor.toggle("skill", name)}
      />
      <BindingSection
        kind="snippet"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={editor.selected.snippet}
        onToggle={(name) => editor.toggle("snippet", name)}
        note="Snippets are consumed by the Agent Manager at agent-authoring time, not by this agent at runtime."
      />
      <BindingSection
        kind="tool"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={editor.selected.tool}
        onToggle={(name) => editor.toggle("tool", name)}
      />
      <BindingSection
        kind="mcp"
        agent={agent}
        capabilities={caps.data ?? []}
        selected={editor.selected.mcp}
        onToggle={(name) => editor.toggle("mcp", name)}
      />

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
