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
  AddSourceError,
  type AddSourceResult,
  type ApiConfig,
  api,
  type CapabilityEntry,
  type CapabilityKind,
  type DeployDiff,
  type DeployTarget,
  type Selection,
  type Source,
  type SourceSyncStatus,
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
  // The authoritative Source list, incl. inactive sources, for the header toggle
  // rows. state.sync is active-only, so a deactivated Source would otherwise vanish
  // and could never be re-enabled in place.
  const sourcesQuery = useQuery({
    queryKey: ["sources"],
    queryFn: () => api.listSources(apiConfig),
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

  // Flip a Source on/off. The catalog is server-side active-only, so invalidating
  // ["kit"] re-fetches the catalog (the deactivated Source's capabilities now gone)
  // and ["sources"] flips the row's active state — both live, no manual refresh.
  // Selection is name-based and source-agnostic (ADR-0023): we do NOT prune the
  // `selected` set here — the daemon drops an absent name from the deploy plan.
  const toggleSource = useMutation({
    mutationFn: (s: Source) =>
      s.active ? api.deactivateSource(apiConfig, s.id) : api.activateSource(apiConfig, s.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
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
  // Human label per Source id (owner/repo), so a Merge row names its Sources the
  // way the header does — never the opaque sourceId. Falls back to the id when a
  // Source isn't in the freshness array.
  const sourceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sourceStatuses) map.set(s.sourceId, shortOrigin(s.origin));
    return map;
  }, [sourceStatuses]);
  const diff = diffQuery.data;

  // The authoritative row set: the full Source list (incl. inactive) when it has
  // resolved. While the query is loading/errored — or returns a non-array payload
  // — fall back to the active-only state.sync rows (read-only, no toggle) so the
  // header never blanks and never renders a wrong toggle state.
  const sources = Array.isArray(sourcesQuery.data) ? sourcesQuery.data : undefined;
  const anyActiveSource = sources?.some((s) => s.active) ?? false;
  const anyInactiveSource = sources?.some((s) => !s.active) ?? false;

  // Hazard cue: deactivating a Source is non-destructive and does NOT prune the
  // working selection (ADR-0023) — so a capability that was deployed from a
  // now-disabled Source stays selected, leaves the active catalog, and shows up
  // under the Deploy diff's "removed" column. Deploying in that state WOULD un-deploy
  // those files. With a Source disabled and a non-empty removed diff, warn that
  // Deploy is destructive here so the safe "hide" gesture isn't confused with it.
  const removedCount = (diffQuery.data?.entries ?? []).filter((e) => e.change === "removed").length;
  const deployWouldRemoveDisabled = anyInactiveSource && removedCount > 0;

  return (
    <div className="kit-page" data-testid="kit-deploy-page">
      <header className="kit-header">
        <div className="kit-header-version">
          <h1>Capabilities</h1>
          <div className="kit-sources" data-testid="kit-sources">
            <SourceRows
              sources={sources}
              syncStatuses={sourceStatuses}
              onToggle={(s) => toggleSource.mutate(s)}
              pendingId={toggleSource.isPending ? toggleSource.variables?.id : undefined}
            />
          </div>
          <AddSourceForm apiConfig={apiConfig} />
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
      {toggleSource.isError && (
        <div className="banner-error" data-testid="kit-source-toggle-error">
          Could not change the Source — {(toggleSource.error as Error).message}
        </div>
      )}
      {deployWouldRemoveDisabled && (
        <div className="banner-warn" data-testid="kit-deploy-disabled-warn">
          Deploying now would remove {removedCount}{" "}
          {removedCount === 1 ? "capability" : "capabilities"} from a disabled Source. Disabling a
          Source only hides it — re-enable the Source above to keep its capabilities deployed.
        </div>
      )}

      <div className="kit-catalog" data-testid="kit-catalog">
        {catalogQuery.isLoading && <CatalogSkeleton />}
        {catalog &&
          catalog.entries.length === 0 &&
          !catalogQuery.isLoading &&
          // Distinguish "every Source is disabled" (re-enable one above) from the
          // genuinely-never-synced / no-sources case (Check for updates). The
          // all-disabled message only applies once the source list has resolved
          // with at least one entry, none active.
          (sources !== undefined && sources.length > 0 && !anyActiveSource ? (
            <div className="empty" data-testid="kit-empty-disabled">
              All Sources are disabled — enable one above to see its capabilities.
            </div>
          ) : (
            <div className="empty" data-testid="kit-empty">
              No capabilities yet — Check for updates to sync the latest Kit.
            </div>
          ))}
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
              sourceLabels={sourceLabels}
              onToggle={(name) => toggleIndividual(kind, name)}
            />
          );
        })}
      </div>
    </div>
  );
}

// The per-Source header rows. Renders from the authoritative Source list (incl.
// inactive) when it has resolved, each row carrying an on/off toggle. While the
// list is loading/errored (`sources` undefined) it falls back to the active-only
// `state.sync` rows, read-only (no toggle), so the header never blanks against an
// already-populated catalog and never shows a wrong toggle state.
// Self-contained Add-Source control (mirrors ApiKeyForm): a git-URL input that
// registers a Source via POST /api/sources, plus the inline status beneath it.
// Owns its own mutation + query invalidation so the page body stays thin. The
// daemon onboards (sync + validate) and KEEPS the Source even when non-conformant
// or empty, so on success we always invalidate ["sources"] (new row) + ["kit"]
// (its capabilities, built from active sources); the returned AddSourceResult
// drives the status copy.
function AddSourceForm({ apiConfig }: { apiConfig: ApiConfig }): JSX.Element {
  const qc = useQueryClient();
  // Uncontrolled (matches the api-key-form pattern): read on submit, cleared on a
  // successful add. `empty` tracks only emptiness so submit can disable on a blank
  // field without making the input controlled.
  const inputRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);

  const addSource = useMutation<AddSourceResult, AddSourceError, string>({
    mutationFn: (origin: string) => api.addSource(apiConfig, origin),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["kit"] });
    },
    onError: (err) => {
      // A malformed 201 still committed the Source server-side — refetch so the
      // new row surfaces even though the body couldn't drive the status banner.
      if (err.cause.kind === "malformed-success") {
        void qc.invalidateQueries({ queryKey: ["sources"] });
        void qc.invalidateQueries({ queryKey: ["kit"] });
      }
    },
  });

  return (
    <>
      <form
        className="add-source-form"
        data-testid="add-source-form"
        onSubmit={(e) => {
          e.preventDefault();
          const origin = inputRef.current?.value.trim() ?? "";
          if (!origin) return;
          addSource.mutate(origin, {
            onSuccess: () => {
              if (inputRef.current) inputRef.current.value = "";
              setEmpty(true);
            },
          });
        }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder="https://github.com/owner/repo"
          disabled={addSource.isPending}
          onInput={(e) => setEmpty(e.currentTarget.value.trim().length === 0)}
          aria-label="Git URL of a Source to add"
          data-testid="add-source-input"
        />
        <button
          type="submit"
          className="button"
          disabled={addSource.isPending || empty}
          data-testid="add-source-submit"
        >
          {addSource.isPending ? "Adding…" : "Add Source"}
        </button>
      </form>
      <AddSourceStatus state={addSource} />
    </>
  );
}

// Inline status beneath the Add-Source form, scoped to this control (not a toast
// — #50 owns that). Driven by the mutation state + the 201 `validation` body:
// pending → error (parsed AddSourceError) → success / empty / conformance-warning.
// The Source is kept on every 201, so the empty + warning cases are informational,
// not failures.
function AddSourceStatus({
  state,
}: {
  state: {
    isPending: boolean;
    isError: boolean;
    error: AddSourceError | null;
    data: AddSourceResult | undefined;
  };
}): JSX.Element | null {
  if (state.isPending) {
    return (
      <div className="add-source-status meta" data-testid="add-source-pending">
        Adding &amp; syncing…
      </div>
    );
  }
  if (state.isError && state.error) {
    return (
      <div className="banner-error add-source-status" data-testid="add-source-error">
        {addSourceErrorMessage(state.error)}
      </div>
    );
  }
  const result = state.data;
  if (!result) return null;
  const lbl = shortOrigin(result.source.origin);
  const { validation } = result;
  if (!validation.conformant) {
    const n = validation.errors.length;
    return (
      <div className="banner-warn add-source-status" data-testid="add-source-warning">
        Added {lbl} — {n} conformance problem{n === 1 ? "" : "s"}; nothing will deploy until fixed.
      </div>
    );
  }
  if (validation.capabilityCount === 0) {
    return (
      <div className="banner-info add-source-status" data-testid="add-source-empty">
        Added {lbl} — no capabilities found.
      </div>
    );
  }
  return (
    <div className="banner-success add-source-status" data-testid="add-source-success">
      Added {lbl} — {validation.capabilityCount} capabilit
      {validation.capabilityCount === 1 ? "y" : "ies"}.
    </div>
  );
}

// Render the parsed AddSourceError cause into user copy: 400 → join issue
// messages; 409 → the duplicate origin; malformed-success → an advisory note (the
// Source was added but the response couldn't be read); else → the carried message.
function addSourceErrorMessage(err: AddSourceError): string {
  const cause = err.cause;
  if (cause.kind === "invalid") {
    return cause.issues.length > 0
      ? cause.issues.map((i) => i.message).join("; ")
      : "Invalid source URL.";
  }
  if (cause.kind === "duplicate") {
    return `Already added: ${cause.origin}`;
  }
  if (cause.kind === "malformed-success") {
    return "Source added, but the response could not be read — refresh to see it.";
  }
  return cause.message;
}

function SourceRows({
  sources,
  syncStatuses,
  onToggle,
  pendingId,
}: {
  sources: Source[] | undefined;
  syncStatuses: SourceSyncStatus[];
  onToggle: (s: Source) => void;
  // The id of the Source whose toggle is currently mutating, so only that row's
  // control disables — an in-flight toggle on one Source must not freeze the rest.
  pendingId: string | undefined;
}): JSX.Element {
  if (sources === undefined) {
    // Fallback: render the active-only sync rows read-only. The first row keeps the
    // stable bare testids (every sync row is, by definition, an active synced row).
    return (
      <>
        {syncStatuses.map((s, idx) => (
          <SourceRow
            key={s.sourceId}
            id={s.sourceId}
            origin={s.origin}
            sync={s}
            active
            anchor={idx === 0}
          />
        ))}
      </>
    );
  }

  const syncById = new Map(syncStatuses.map((s) => [s.sourceId, s] as const));
  // Stable freshness-testid anchor: the bare `kit-sha`/`kit-freshness` go on the
  // FIRST row that has a state.sync entry (the first *synced* row), never raw idx 0
  // — the Starter seeds first in registry order and is SHA-less/deactivatable, so
  // anchoring on position would put the stable testid on a SHA-less row.
  const firstSyncedId = sources.find((s) => syncById.has(s.id))?.id;
  return (
    <>
      {sources.map((s) => (
        <SourceRow
          key={s.id}
          id={s.id}
          origin={s.origin}
          sync={syncById.get(s.id)}
          active={s.active}
          anchor={s.id === firstSyncedId}
          onToggle={() => onToggle(s)}
          togglePending={pendingId === s.id}
        />
      ))}
    </>
  );
}

// A single Source header row. With `onToggle` present it renders an on/off toggle
// bound to `active`; without it (the loading fallback) it is read-only. SHA +
// freshness render only for an active, currently-synced Source; an inactive row
// is muted and shows origin only. The bare `kit-sha`/`kit-freshness` testids land
// on the `anchor` (first synced) row; every other synced row gets the `-<id>`
// suffix; un-synced/inactive rows carry no SHA/freshness testid at all.
function SourceRow({
  id,
  origin,
  sync,
  active,
  anchor,
  onToggle,
  togglePending,
}: {
  id: string;
  origin: string;
  sync: SourceSyncStatus | undefined;
  active: boolean;
  anchor: boolean;
  onToggle?: () => void;
  togglePending?: boolean;
}): JSX.Element {
  const fresh = sync ? freshnessOf(sync.state) : null;
  return (
    <div
      className={`kit-source-row ${active ? "" : "kit-source-row-inactive"}`}
      data-testid={`kit-source-${id}`}
    >
      <span className="kit-source-origin" title={origin}>
        {shortOrigin(origin)}
      </span>
      {sync && fresh && (
        <>
          <span
            className="kit-sha"
            data-testid={anchor ? "kit-sha" : `kit-sha-${id}`}
            title={sync.sha ?? ""}
          >
            {shortSha(sync.sha)}
          </span>
          <span
            className={`kit-fresh ${fresh.className}`}
            data-testid={anchor ? "kit-freshness" : `kit-freshness-${id}`}
          >
            {fresh.label}
          </span>
          {sync.rateLimitReset !== undefined && (
            <span className="kit-rate-reset">
              resets {new Date(sync.rateLimitReset * 1000).toLocaleTimeString()}
            </span>
          )}
        </>
      )}
      {onToggle && (
        <label
          className={`kit-source-toggle ${active ? "on" : "off"}`}
          title={active ? "Deactivate" : "Activate"}
        >
          <input
            type="checkbox"
            className="kit-source-switch"
            checked={active}
            onChange={onToggle}
            disabled={togglePending}
            data-testid={`kit-source-toggle-${id}`}
            aria-label={`${active ? "Deactivate" : "Activate"} ${shortOrigin(origin)}`}
          />
          {/* Visible on/off word so the state never relies on color/opacity alone. */}
          <span className="kit-source-toggle-label" aria-hidden="true">
            {active ? "On" : "Off"}
          </span>
        </label>
      )}
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
  sourceLabels,
  onToggle,
}: {
  kind: CapabilityKind;
  entries: CapabilityEntry[];
  selected: Set<string>;
  deployed: Set<string>;
  onDisk: Map<string, VerifyStatus>;
  sourceLabels: Map<string, string>;
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

  // CapabilityKeys with >1 variant (same (kind,name), different ContentSha). A
  // multi-variant row disambiguates its testid by a short contentSha suffix; the
  // common single-variant row keeps the stable bare testid.
  const variantCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    return counts;
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
              shadowed: e.shadowed,
              isSelected,
              isDeployed,
              disk,
            });
            const blocked = !e.deployable && !e.shadowed;
            const selectable = e.deployable;
            // Multi-variant rows key uniformly on the short contentSha (winner and
            // losers alike) so React keys + testids are unique across ≥3 variants.
            const multi = (variantCount.get(e.name) ?? 1) > 1;
            const shortSha = e.contentSha.slice(0, 8);
            const rowKey = multi ? `${group}/${e.name}/${shortSha}` : `${group}/${e.name}`;
            const rowTestId = multi
              ? `kit-row-${kind}-${e.name}-${shortSha}`
              : `kit-row-${kind}-${e.name}`;
            const indicatorTestId = multi
              ? `kit-indicator-${e.name}-${shortSha}`
              : `kit-indicator-${e.name}`;
            return (
              <button
                type="button"
                key={rowKey}
                className={`kit-row ${isSelected ? "selected" : ""} ${blocked ? "blocked" : ""} ${
                  e.shadowed ? "shadowed" : ""
                }`}
                onClick={() => selectable && onToggle(e.name)}
                disabled={!selectable}
                data-testid={rowTestId}
              >
                <span
                  className={`kit-row-check ${isSelected ? "checked" : ""}`}
                  aria-hidden="true"
                />
                <span className="kit-row-main">
                  <span className="kit-row-name">{e.name}</span>
                  {e.description && <span className="kit-row-desc">{e.description}</span>}
                  {/* Merge labels: the Source(s) providing this variant, by their
                      human owner/repo label (the same the header uses). */}
                  {e.sourceIds.length > 1 && (
                    <span className="kit-row-sources" data-testid={`kit-row-sources-${e.name}`}>
                      {e.sourceIds.map((sid) => (
                        <span className="kit-source-label" key={sid}>
                          {sourceLabels.get(sid) ?? sid}
                        </span>
                      ))}
                    </span>
                  )}
                  {blocked && (
                    <span className="kit-row-blocked">{e.blockedReason ?? "un-deployable"}</span>
                  )}
                </span>
                {indicator && (
                  <span
                    className={`kit-indicator kit-indicator-${indicator}`}
                    data-testid={indicatorTestId}
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

// Row indicator states. `blocked` and `duplicate` are the non-deployable states
// (malformed vs precedence-shadowed); the next four are ledger/selection-derived;
// `missing` and `drifted` are the disk-truth states from the verify pass.
type Indicator =
  | "blocked"
  | "duplicate"
  | "deployed"
  | "pending"
  | "removing"
  | "missing"
  | "drifted"
  | "";

const INDICATOR_LABEL: Record<Exclude<Indicator, "">, string> = {
  blocked: "blocked",
  duplicate: "not deployed (duplicate)",
  deployed: "deployed",
  pending: "pending",
  removing: "removing",
  missing: "missing on disk",
  drifted: "drifted",
};

// Fold ledger ownership + working selection + on-disk verify status into one
// indicator. A shadowed variant (lost precedence) reads `duplicate` — a third
// state distinct from `blocked` (malformed). Disk truth WINS for a deployed
// capability: a ledger-owned row whose files were removed reads `missing`; one
// edited since deploy reads `drifted`.
function rowIndicator(args: {
  deployable: boolean;
  shadowed: boolean;
  isSelected: boolean;
  isDeployed: boolean;
  disk: VerifyStatus | undefined;
}): Indicator {
  const { deployable, shadowed, isSelected, isDeployed, disk } = args;
  if (shadowed) return "duplicate";
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
