// KitDeployPage — the capability deploy-manager (Plan C2).
//
// Full Kit catalog grouped by kind + @-namespace, each row name/description +
// deployed/pending indicator. Header: synced version (short SHA) + freshness
// state (update available / check failed / rate-limited) + Check for updates +
// explicit Deploy. Controls: preset selector (seeds Selection), per-CLI target
// toggles, individual toggles, the Deploy Diff (added/removed/changed incl. the
// CLAUDE.md-replacement warning). Deploy is NEVER automatic.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ApiConfig,
  api,
  type KitCapabilityEntry,
  type KitCapabilityKind,
  type KitDeployDiff,
  type KitDeployTarget,
  type KitSelection,
} from "../api.ts";

const KINDS: KitCapabilityKind[] = ["instruction", "skill", "agent", "plugin", "bundle"];
const KIND_LABEL: Record<KitCapabilityKind, string> = {
  instruction: "Instructions",
  skill: "Skills",
  agent: "Agents",
  plugin: "Plugins",
  bundle: "Bundles",
};

const KIND_TO_CAP: Record<KitCapabilityKind, keyof KitSelection["add"]> = {
  instruction: "instructions",
  skill: "skills",
  agent: "agents",
  plugin: "plugins",
  bundle: "bundles",
};

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

type Freshness = {
  label: string;
  className: string;
};

function freshnessOf(state: string | undefined): Freshness {
  switch (state) {
    case "rate_limited":
      return { label: "Rate-limited", className: "kit-fresh-error" };
    case "check_failed":
      return { label: "Check failed", className: "kit-fresh-error" };
    default:
      return { label: "Up to date", className: "kit-fresh-ok" };
  }
}

export function KitDeployPage({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const qc = useQueryClient();

  const catalogQuery = useQuery({
    queryKey: ["kit", "catalog"],
    queryFn: () => api.getKitCatalog(apiConfig),
  });
  const stateQuery = useQuery({
    queryKey: ["kit", "state"],
    queryFn: () => api.getKitState(apiConfig),
  });

  // Selection state: preset names, per-kind individual add/remove toggles,
  // target CLIs. Seeded by a preset; toggles layer on top.
  const [presets, setPresets] = useState<string[]>([]);
  const [add, setAdd] = useState<KitSelection["add"]>(emptyCaps());
  const [remove, setRemove] = useState<KitSelection["remove"]>(emptyCaps());
  const [targets, setTargets] = useState<KitDeployTarget[]>(["claude"]);

  const catalog = catalogQuery.data;
  const state = stateQuery.data;

  // The concrete per-kind selected name set (preset seed + add − remove).
  const selected = useMemo(() => {
    const seed = emptyCaps();
    if (catalog) {
      for (const pn of presets) {
        const preset = catalog.presets.find((p) => p.name === pn);
        if (!preset) continue;
        for (const k of KINDS) {
          const cap = KIND_TO_CAP[k];
          seed[cap].push(...preset.capabilities[cap]);
        }
      }
    }
    const out = emptyCaps();
    for (const k of KINDS) {
      const cap = KIND_TO_CAP[k];
      const removed = new Set(remove[cap]);
      out[cap] = Array.from(new Set([...seed[cap], ...add[cap]])).filter((n) => !removed.has(n));
    }
    return out;
  }, [catalog, presets, add, remove]);

  const selection: KitSelection = useMemo(
    () => ({ presets, add, remove, targets }),
    [presets, add, remove, targets],
  );

  // Currently-deployed (ledger-owned) names, for the deployed/pending indicator.
  const deployed = useMemo(() => {
    const ledger = state?.ledger;
    return {
      instruction: new Set((ledger?.instructions ?? []).map((e) => e.name)),
      skill: new Set((ledger?.skills ?? []).map((e) => e.name)),
      agent: new Set((ledger?.agentDefs ?? []).map((e) => e.name)),
      plugin: new Set((ledger?.plugins ?? []).map((e) => e.name)),
      bundle: new Set((ledger?.bundles ?? []).map((e) => e.name)),
    };
  }, [state]);

  // Seed the working selection from the deployed Ledger — the single source of
  // truth — once the state query first resolves, so the page opens reflecting
  // what is actually deployed rather than blank. User edits then layer on top;
  // the guard keeps a post-deploy refetch from clobbering those edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !stateQuery.isSuccess) return;
    seededRef.current = true;
    const ledger = stateQuery.data?.ledger;
    if (!ledger) return;
    setAdd({
      instructions: ledger.instructions.map((e) => e.name),
      skills: ledger.skills.map((e) => e.name),
      agents: ledger.agentDefs.map((e) => e.name),
      plugins: ledger.plugins.map((e) => e.name),
      bundles: ledger.bundles.map((e) => e.name),
    });
    const seededTargets = ledger.agents.filter(
      (a): a is KitDeployTarget => a === "claude" || a === "codex",
    );
    if (seededTargets.length > 0) setTargets(seededTargets);
  }, [stateQuery.isSuccess, stateQuery.data]);

  const hasSelection = KINDS.some((k) => selected[KIND_TO_CAP[k]].length > 0);

  const diffQuery = useQuery({
    queryKey: ["kit", "diff", JSON.stringify(selection)],
    queryFn: () => api.kitDiff(apiConfig, selection),
    enabled: Boolean(catalog) && hasSelection,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncKit(apiConfig),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["kit"] });
    },
  });

  const deployMutation = useMutation({
    mutationFn: () => api.kitDeploy(apiConfig, selection),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kit", "state"] });
      void qc.invalidateQueries({ queryKey: ["kit", "diff"] });
    },
  });

  function togglePreset(name: string): void {
    setPresets((cur) => (cur.includes(name) ? cur.filter((p) => p !== name) : [...cur, name]));
    // Reset manual overrides when the preset seed changes, so the seed is authoritative.
    setAdd(emptyCaps());
    setRemove(emptyCaps());
  }

  function toggleTarget(t: KitDeployTarget): void {
    setTargets((cur) => {
      if (cur.includes(t)) {
        const next = cur.filter((x) => x !== t);
        return next.length > 0 ? next : cur; // at least one target required
      }
      return [...cur, t];
    });
  }

  function toggleIndividual(kind: KitCapabilityKind, name: string, isSeeded: boolean): void {
    const cap = KIND_TO_CAP[kind];
    const isSelected = selected[cap].includes(name);
    if (isSelected) {
      // Deselect: if seeded, push to remove; else drop from add.
      if (isSeeded) {
        setRemove((cur) => ({ ...cur, [cap]: Array.from(new Set([...cur[cap], name])) }));
      } else {
        setAdd((cur) => ({ ...cur, [cap]: cur[cap].filter((n) => n !== name) }));
      }
    } else {
      // Select: drop from remove if present, else push to add.
      if (remove[cap].includes(name)) {
        setRemove((cur) => ({ ...cur, [cap]: cur[cap].filter((n) => n !== name) }));
      } else {
        setAdd((cur) => ({ ...cur, [cap]: Array.from(new Set([...cur[cap], name])) }));
      }
    }
  }

  const fresh = freshnessOf(state?.sync.state);
  const diff = diffQuery.data;

  return (
    <div className="kit-page" data-testid="kit-deploy-page">
      <header className="kit-header">
        <div className="kit-header-version">
          <h1>Capabilities</h1>
          <span className="kit-sha" data-testid="kit-sha" title={state?.sync.sha ?? ""}>
            {shortSha(state?.sync.sha ?? null)}
          </span>
          <span className={`kit-fresh ${fresh.className}`} data-testid="kit-freshness">
            {fresh.label}
          </span>
          {state?.sync.rateLimitReset !== undefined && (
            <span className="kit-rate-reset">
              resets {new Date(state.sync.rateLimitReset * 1000).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="kit-header-actions">
          <button
            type="button"
            className="button ghost"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="kit-check-updates"
          >
            {syncMutation.isPending ? "Checking…" : "Check for updates"}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => deployMutation.mutate()}
            disabled={!hasSelection || deployMutation.isPending}
            data-testid="kit-deploy"
          >
            {deployMutation.isPending ? "Deploying…" : "Deploy"}
          </button>
        </div>
      </header>

      {catalogQuery.isError && <div className="banner-error">Failed to load catalog.</div>}

      <div className="kit-controls">
        <div className="kit-presets" data-testid="kit-presets">
          <span className="kit-control-label">Preset</span>
          {(catalog?.presets ?? []).map((p) => (
            <button
              type="button"
              key={p.name}
              className={`badge kit-preset ${presets.includes(p.name) ? "active" : ""}`}
              onClick={() => togglePreset(p.name)}
              title={p.description}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="kit-targets" data-testid="kit-targets">
          <span className="kit-control-label">Targets</span>
          {(["claude", "codex"] as KitDeployTarget[]).map((t) => (
            <label key={t} className="kit-target-toggle">
              <input
                type="checkbox"
                checked={targets.includes(t)}
                onChange={() => toggleTarget(t)}
                data-testid={`kit-target-${t}`}
              />
              {t === "claude" ? "Claude" : "Codex"}
            </label>
          ))}
        </div>
      </div>

      {diff && diff.entries.length > 0 && <DeployDiffPanel diff={diff} />}

      {deployMutation.isError && (
        <div className="banner-error" data-testid="kit-deploy-error">
          Deploy failed: {(deployMutation.error as Error).message}
        </div>
      )}
      {deployMutation.isSuccess && (!diff || diff.entries.length === 0) && (
        <div className="kit-deploy-ok" data-testid="kit-deploy-ok">
          Deployed. Diff cleared.
        </div>
      )}

      <div className="kit-catalog" data-testid="kit-catalog">
        {catalogQuery.isLoading && <div className="empty">Loading catalog…</div>}
        {catalog && catalog.entries.length === 0 && !catalogQuery.isLoading && (
          <div className="empty" data-testid="kit-empty">
            No capabilities yet — Check for updates to sync the latest Kit.
          </div>
        )}
        {KINDS.map((kind) => {
          const entries = (catalog?.entries ?? []).filter((e) => e.kind === kind);
          if (entries.length === 0) return null;
          return (
            <KindSection
              key={kind}
              kind={kind}
              entries={entries}
              selected={new Set(selected[KIND_TO_CAP[kind]])}
              deployed={deployed[kind]}
              onToggle={(name, seeded) => toggleIndividual(kind, name, seeded)}
              seededNames={seededNames(catalog?.presets ?? [], presets, kind)}
            />
          );
        })}
      </div>
    </div>
  );
}

function KindSection({
  kind,
  entries,
  selected,
  deployed,
  onToggle,
  seededNames,
}: {
  kind: KitCapabilityKind;
  entries: KitCapabilityEntry[];
  selected: Set<string>;
  deployed: Set<string>;
  onToggle: (name: string, seeded: boolean) => void;
  seededNames: Set<string>;
}): JSX.Element {
  // Group by @-namespace within the kind.
  const groups = useMemo(() => {
    const map = new Map<string, KitCapabilityEntry[]>();
    for (const e of entries) {
      const g = e.group || "";
      const arr = map.get(g) ?? [];
      arr.push(e);
      map.set(g, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  return (
    <section className="kit-kind" data-testid={`kit-kind-${kind}`}>
      <h2 className="kit-kind-title">{KIND_LABEL[kind]}</h2>
      {groups.map(([group, rows]) => (
        <div className="kit-group" key={group || "(root)"}>
          {group && <div className="kit-group-name">{group}</div>}
          {rows.map((e) => {
            const isSelected = selected.has(e.name);
            const isDeployed = deployed.has(e.name);
            const indicator = !e.deployable
              ? "blocked"
              : isDeployed && isSelected
                ? "deployed"
                : isSelected
                  ? "pending"
                  : isDeployed
                    ? "removing"
                    : "";
            return (
              <button
                type="button"
                key={`${group}/${e.name}`}
                className={`kit-row ${isSelected ? "selected" : ""} ${e.deployable ? "" : "blocked"}`}
                onClick={() => e.deployable && onToggle(e.name, seededNames.has(e.name))}
                disabled={!e.deployable}
                data-testid={`kit-row-${kind}-${e.name}`}
              >
                <span
                  className={`kit-row-check ${isSelected ? "checked" : ""}`}
                  aria-hidden="true"
                />
                <span className="kit-row-main">
                  <span className="kit-row-name">{e.name}</span>
                  {e.description && <span className="kit-row-desc">{e.description}</span>}
                  {!e.deployable && (
                    <span className="kit-row-blocked">{e.blockedReason ?? "un-deployable"}</span>
                  )}
                </span>
                {indicator && (
                  <span
                    className={`kit-indicator kit-indicator-${indicator}`}
                    data-testid={`kit-indicator-${e.name}`}
                  >
                    {indicator}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}

function DeployDiffPanel({ diff }: { diff: KitDeployDiff }): JSX.Element {
  const added = diff.entries.filter((e) => e.change === "added");
  const removed = diff.entries.filter((e) => e.change === "removed");
  const changed = diff.entries.filter((e) => e.change === "changed");
  const userFileWarning = diff.entries.some((e) => e.replacesUserFile);
  return (
    <div className="kit-diff" data-testid="kit-diff">
      <h2 className="kit-diff-title">Deploy diff</h2>
      {userFileWarning && (
        <div className="banner-error kit-diff-warn" data-testid="kit-diff-userfile-warn">
          This deploy replaces an existing user-authored CLAUDE.md (backed up to
          CLAUDE.md.hive-bak).
        </div>
      )}
      <div className="kit-diff-cols">
        <DiffCol label="Added" tone="added" entries={added} />
        <DiffCol label="Removed" tone="removed" entries={removed} />
        <DiffCol label="Changed" tone="changed" entries={changed} />
      </div>
    </div>
  );
}

function DiffCol({
  label,
  tone,
  entries,
}: {
  label: string;
  tone: string;
  entries: KitDeployDiff["entries"];
}): JSX.Element {
  return (
    <div className={`kit-diff-col kit-diff-${tone}`} data-testid={`kit-diff-${tone}`}>
      <div className="kit-diff-col-head">
        {label} ({entries.length})
      </div>
      <ul>
        {entries.map((e) => (
          <li key={`${e.kind}/${e.name}`}>
            <span className="kit-diff-kind">{e.kind}</span> {e.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function seededNames(
  presets: { name: string; capabilities: KitSelection["add"] }[],
  selectedPresets: string[],
  kind: KitCapabilityKind,
): Set<string> {
  const cap = KIND_TO_CAP[kind];
  const out = new Set<string>();
  for (const pn of selectedPresets) {
    const p = presets.find((x) => x.name === pn);
    if (p) for (const n of p.capabilities[cap]) out.add(n);
  }
  return out;
}

function emptyCaps(): KitSelection["add"] {
  return { instructions: [], skills: [], agents: [], plugins: [], bundles: [] };
}
