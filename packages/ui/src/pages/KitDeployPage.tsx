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
  type CapabilityEntry,
  type CapabilityKind,
  type DeployDiff,
  type DeployTarget,
  type Selection,
  type VerifyReport,
  type VerifyStatus,
} from "../api.ts";
import { Skeleton, SkeletonGroup } from "../components/Skeleton.tsx";
import { signalDeployInFlight } from "../platform/deploy-in-flight.ts";

const KINDS: CapabilityKind[] = ["instruction", "skill", "agent", "plugin", "bundle"];
const KIND_LABEL: Record<CapabilityKind, string> = {
  instruction: "Instructions",
  skill: "Skills",
  agent: "Agents",
  plugin: "Plugins",
  bundle: "Bundles",
};

const KIND_TO_CAP: Record<CapabilityKind, keyof Selection["add"]> = {
  instruction: "instructions",
  skill: "skills",
  agent: "agents",
  plugin: "plugins",
  bundle: "bundles",
};

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

// Short, human-readable origin label (owner/repo for a GitHub URL, else the
// last path segment / host).
function shortOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length >= 2)
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0] ?? url.hostname;
    return url.hostname;
  } catch {
    return origin;
  }
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
    case "local":
      // The bundled Starter Source: copied from the in-repo package, never fetched
      // — no SHA, no network state. Surface it as bundled, not "Up to date".
      return { label: "Bundled", className: "kit-fresh-ok" };
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

  // The concrete per-kind selected name set is the single source of truth.
  // Presets are a convenience tool over it (seed / clear / active-overview), not
  // stored selection — there is no preset provenance to persist (the Ledger
  // records resolved names only), so a preset reads "active" purely by whether
  // all its capabilities are currently selected.
  const [selected, setSelected] = useState<Selection["add"]>(emptyCaps());
  const [targets, setTargets] = useState<DeployTarget[]>(["claude"]);

  const catalog = catalogQuery.data;
  const state = stateQuery.data;

  // Wire selection: presets/remove stay empty — the resolved `selected` set is
  // sent as `add`, which the daemon resolves identically (presets ∪ add − remove).
  const selection: Selection = useMemo(
    () => ({ presets: [], add: selected, remove: emptyCaps(), targets }),
    [selected, targets],
  );

  // On-disk self-check (Feature 1/2): runs on load and is re-fetched after every
  // deploy (the deploy mutation invalidates the ["kit","verify"] key). The row
  // indicator reflects DISK reality, not just the ledger.
  const verifyQuery = useQuery({
    queryKey: ["kit", "verify"],
    queryFn: () => api.getKitVerify(apiConfig),
  });

  // Per-kind, per-name collapsed on-disk status for the row indicator. A
  // capability split across targets collapses to its worst state
  // (drifted > missing > present/recorded) so a single missing/edited target
  // still flags the row.
  const onDisk = useMemo(() => collapseVerify(verifyQuery.data), [verifyQuery.data]);

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

  // Seed the working selection from the deployed Ledger once the state query
  // first resolves, so the page opens reflecting what is actually deployed rather
  // than blank. User edits then layer on top; the guard keeps a post-deploy
  // refetch from clobbering those edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !stateQuery.isSuccess) return;
    seededRef.current = true;
    const ledger = stateQuery.data?.ledger;
    if (!ledger) return;
    setSelected({
      instructions: ledger.instructions.map((e) => e.name),
      skills: ledger.skills.map((e) => e.name),
      agents: ledger.agentDefs.map((e) => e.name),
      plugins: ledger.plugins.map((e) => e.name),
      bundles: ledger.bundles.map((e) => e.name),
    });
    const seededTargets = ledger.agents.filter(
      (a): a is DeployTarget => a === "claude" || a === "codex",
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
      // Re-run the on-disk self-check so rows reflect what the deploy just wrote.
      void qc.invalidateQueries({ queryKey: ["kit", "verify"] });
    },
  });

  // Feature 3: signal the Electron main process while a deploy is in flight, so a
  // quit during the deploy prompts a confirm instead of SIGKILLing the daemon
  // mid-write. The signal toggles with the mutation's pending state and is cleared
  // when it settles (incl. on unmount). No-op in a plain browser tab.
  const deployPending = deployMutation.isPending;
  useEffect(() => {
    void signalDeployInFlight(deployPending);
    return () => {
      if (deployPending) void signalDeployInFlight(false);
    };
  }, [deployPending]);

  // A preset is just a tool over the selection: clicking an inactive preset
  // selects all its capabilities; clicking an active one (all selected)
  // deselects them — except any also covered by another still-active preset, so
  // shared capabilities survive and that other preset stays active.
  function togglePreset(name: string): void {
    if (!catalog) return;
    const preset = catalog.presets.find((p) => p.name === name);
    if (!preset) return;
    const allPresets = catalog.presets;
    setSelected((cur) => {
      if (!presetActive(preset, cur)) {
        const next = emptyCaps();
        for (const k of KINDS) {
          const cap = KIND_TO_CAP[k];
          next[cap] = Array.from(new Set([...cur[cap], ...preset.capabilities[cap]]));
        }
        return next;
      }
      const keep = emptyCapSets();
      for (const other of allPresets) {
        if (other.name === name || !presetActive(other, cur)) continue;
        for (const k of KINDS) {
          const cap = KIND_TO_CAP[k];
          for (const n of other.capabilities[cap]) keep[cap].add(n);
        }
      }
      const next = emptyCaps();
      for (const k of KINDS) {
        const cap = KIND_TO_CAP[k];
        const drop = new Set(preset.capabilities[cap].filter((n) => !keep[cap].has(n)));
        next[cap] = cur[cap].filter((n) => !drop.has(n));
      }
      return next;
    });
  }

  function toggleTarget(t: DeployTarget): void {
    setTargets((cur) => {
      if (cur.includes(t)) {
        const next = cur.filter((x) => x !== t);
        return next.length > 0 ? next : cur; // at least one target required
      }
      return [...cur, t];
    });
  }

  function toggleIndividual(kind: CapabilityKind, name: string): void {
    const cap = KIND_TO_CAP[kind];
    setSelected((cur) => {
      const has = cur[cap].includes(name);
      return {
        ...cur,
        [cap]: has ? cur[cap].filter((n) => n !== name) : [...cur[cap], name],
      };
    });
  }

  const sourceStatuses = state?.sync ?? [];
  const diff = diffQuery.data;

  return (
    <div className="kit-page" data-testid="kit-deploy-page">
      <header className="kit-header">
        <div className="kit-header-version">
          <h1>Capabilities</h1>
          <div className="kit-sources" data-testid="kit-sources">
            {sourceStatuses.map((s, idx) => {
              const fresh = freshnessOf(s.state);
              // Preserve the stable single-Source testids on the FIRST row so
              // existing selectors still resolve; add per-Source testids too.
              const first = idx === 0;
              return (
                <div
                  className="kit-source-row"
                  key={s.sourceId}
                  data-testid={`kit-source-${s.sourceId}`}
                >
                  <span className="kit-source-origin" title={s.origin}>
                    {shortOrigin(s.origin)}
                  </span>
                  <span
                    className="kit-sha"
                    data-testid={first ? "kit-sha" : `kit-sha-${s.sourceId}`}
                    title={s.sha ?? ""}
                  >
                    {shortSha(s.sha)}
                  </span>
                  <span
                    className={`kit-fresh ${fresh.className}`}
                    data-testid={first ? "kit-freshness" : `kit-freshness-${s.sourceId}`}
                  >
                    {fresh.label}
                  </span>
                  {s.rateLimitReset !== undefined && (
                    <span className="kit-rate-reset">
                      resets {new Date(s.rateLimitReset * 1000).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
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
              className={`badge kit-preset ${presetActive(p, selected) ? "active" : ""}`}
              onClick={() => togglePreset(p.name)}
              title={p.description}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="kit-targets" data-testid="kit-targets">
          <span className="kit-control-label">Targets</span>
          {(["claude", "codex"] as DeployTarget[]).map((t) => (
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
        {catalogQuery.isLoading && <CatalogSkeleton />}
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
              onDisk={onDisk[kind]}
              onToggle={(name) => toggleIndividual(kind, name)}
            />
          );
        })}
      </div>
    </div>
  );
}

// Content-shaped placeholder for the loading catalog: a couple of skeleton
// "kind sections" (title + a few rows) mirroring .kit-kind → .kit-row.
function CatalogSkeleton(): JSX.Element {
  // Two skeleton kind-sections, identified by stable synthetic names so the
  // placeholder rows carry non-index keys.
  const sections = [
    { id: "a", rows: ["a1", "a2", "a3"] },
    { id: "b", rows: ["b1", "b2"] },
  ];
  return (
    <SkeletonGroup
      label="Loading catalog…"
      testId="kit-catalog-skeleton"
      className="kit-catalog-skeleton"
    >
      {sections.map((section) => (
        <div className="skeleton-kind" key={section.id}>
          <Skeleton width="40%" height="18px" />
          {section.rows.map((rowId) => (
            <div className="skeleton-row" key={rowId}>
              <Skeleton width="16px" height="16px" radius="4px" />
              <div className="skeleton-row-main">
                <Skeleton width="35%" height="13px" />
                <Skeleton width="70%" height="12px" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </SkeletonGroup>
  );
}

function KindSection({
  kind,
  entries,
  selected,
  deployed,
  onDisk,
  onToggle,
}: {
  kind: CapabilityKind;
  entries: CapabilityEntry[];
  selected: Set<string>;
  deployed: Set<string>;
  onDisk: Map<string, VerifyStatus>;
  onToggle: (name: string) => void;
}): JSX.Element {
  // Group by @-namespace within the kind.
  const groups = useMemo(() => {
    const map = new Map<string, CapabilityEntry[]>();
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
            const disk = onDisk.get(e.name);
            const indicator = rowIndicator({
              deployable: e.deployable,
              isSelected,
              isDeployed,
              disk,
            });
            return (
              <button
                type="button"
                key={`${group}/${e.name}`}
                className={`kit-row ${isSelected ? "selected" : ""} ${e.deployable ? "" : "blocked"}`}
                onClick={() => e.deployable && onToggle(e.name)}
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
                    data-status={indicator}
                  >
                    {INDICATOR_LABEL[indicator]}
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

function DeployDiffPanel({ diff }: { diff: DeployDiff }): JSX.Element {
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
  entries: DeployDiff["entries"];
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

// Row indicator states. The first four are the original ledger/selection-derived
// states; `missing` and `drifted` are the disk-truth states from the verify pass.
type Indicator = "blocked" | "deployed" | "pending" | "removing" | "missing" | "drifted" | "";

const INDICATOR_LABEL: Record<Exclude<Indicator, "">, string> = {
  blocked: "blocked",
  deployed: "deployed",
  pending: "pending",
  removing: "removing",
  missing: "missing on disk",
  drifted: "drifted",
};

// Fold ledger ownership + working selection + on-disk verify status into one
// indicator. Disk truth WINS for a deployed capability: a ledger-owned row whose
// files were removed reads `missing`; one edited since deploy reads `drifted`.
function rowIndicator(args: {
  deployable: boolean;
  isSelected: boolean;
  isDeployed: boolean;
  disk: VerifyStatus | undefined;
}): Indicator {
  const { deployable, isSelected, isDeployed, disk } = args;
  if (!deployable) return "blocked";
  if (isDeployed) {
    if (disk === "missing") return "missing";
    if (disk === "drifted") return "drifted";
    if (isSelected) return "deployed";
    return "removing";
  }
  return isSelected ? "pending" : "";
}

// Collapse the per-target verify report into a per-kind, per-name single status.
// Worst-state wins so a row split across targets still flags a problem:
// drifted > missing > present > recorded.
const STATUS_RANK: Record<VerifyStatus, number> = {
  drifted: 3,
  missing: 2,
  present: 1,
  recorded: 0,
};

function collapseVerify(
  report: VerifyReport | undefined,
): Record<CapabilityKind, Map<string, VerifyStatus>> {
  const out: Record<CapabilityKind, Map<string, VerifyStatus>> = {
    instruction: new Map(),
    skill: new Map(),
    agent: new Map(),
    plugin: new Map(),
    bundle: new Map(),
  };
  if (!report) return out;
  for (const e of report.entries) {
    let worst: VerifyStatus | undefined;
    for (const t of e.targets) {
      if (!worst || STATUS_RANK[t.status] > STATUS_RANK[worst]) worst = t.status;
    }
    if (worst) out[e.kind].set(e.name, worst);
  }
  return out;
}

// A preset is active iff it has at least one capability and every one is in the
// current selection. Empty presets never read active (nothing to reflect).
function presetActive(
  preset: { capabilities: Selection["add"] },
  selected: Selection["add"],
): boolean {
  let any = false;
  for (const k of KINDS) {
    const cap = KIND_TO_CAP[k];
    const sel = new Set(selected[cap]);
    for (const n of preset.capabilities[cap]) {
      any = true;
      if (!sel.has(n)) return false;
    }
  }
  return any;
}

function emptyCaps(): Selection["add"] {
  return { instructions: [], skills: [], agents: [], plugins: [], bundles: [] };
}

function emptyCapSets(): Record<keyof Selection["add"], Set<string>> {
  return {
    instructions: new Set(),
    skills: new Set(),
    agents: new Set(),
    plugins: new Set(),
    bundles: new Set(),
  };
}
